import asyncio
import json
import time
from typing import Any, Callable, Dict, Optional

import httpx

from .core import HTTPClientPool
from .ollama_utils import (
    build_ollama_final_answer_retry_payload,
    collect_ollama_message_parts,
    describe_ollama_empty_content,
    finalize_ollama_content,
    is_ollama_reasoning_only_response,
    should_retry_without_ollama_think,
)


class OllamaNativeAdapter:
    @staticmethod
    def format_request_error(req_err: Exception, provider_label: str = "Ollama", timeout: float = None) -> str:
        """Единое форматирование ошибок запроса к Ollama.

        RU-FORK FIX: str(TimeoutError) пуст -> раньше в лог уходило "请求异常:" без
        причины. Теперь таймаут и пустые сообщения раскрываются явно.
        """
        import asyncio as _asyncio
        if isinstance(req_err, (httpx.TimeoutException, _asyncio.TimeoutError, TimeoutError)):
            t = f" {int(timeout)}s" if timeout else ""
            return (f"{provider_label} 请求超时{t} (timeout) — модель не успела ответить. "
                    f"Уменьшите длину текста или повторите запрос (первый прогон после "
                    f"простоя включает загрузку модели в VRAM и занимает больше времени).")
        name = type(req_err).__name__
        msg = str(req_err).strip()
        if not msg:
            msg = repr(req_err)
        return f"{provider_label} 请求异常: {name}: {msg}"

    @staticmethod
    async def stream_chat(
        *,
        model: str,
        native_base: str,
        payload: Dict[str, Any],
        timeout: float,
        pbar: Any,
        stream_callback: Optional[Callable[[str], None]] = None,
        cancel_event: Optional[Any] = None,
        provider_label: str = "Ollama",
        include_reasoning: bool = False,
    ) -> Dict[str, Any]:
        start_time = time.perf_counter()

        client = HTTPClientPool.get_client(
            provider="ollama_native",
            base_url=native_base,
            timeout=timeout,
            verify_ssl=True,
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
        )

        try:
            async def request_once(current_payload: Dict[str, Any]) -> Dict[str, Any]:
                full_content = ""
                reasoning_content = ""

                async with client.stream(
                    "POST",
                    f"{native_base}/api/chat",
                    json=current_payload,
                    follow_redirects=True,
                ) as resp:
                    if resp.status_code != 200:
                        error_text = await resp.aread()
                        try:
                            error_data = json.loads(error_text)
                            error_msg = error_data.get("error", f"HTTP {resp.status_code}")
                        except Exception:
                            error_msg = f"HTTP {resp.status_code}"
                        return {
                            "success": False,
                            "error": error_msg,
                            "status_code": resp.status_code,
                        }

                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk_data = json.loads(line)

                            if chunk_data.get("error"):
                                error_msg = chunk_data.get("error")
                                if isinstance(error_msg, dict):
                                    error_msg = error_msg.get("message", str(error_msg))
                                else:
                                    error_msg = str(error_msg)
                                lowered = error_msg.lower()
                                status_code = 400 if (
                                    "think" in lowered
                                    or "support" in lowered
                                    or "invalid" in lowered
                                ) else 200
                                return {
                                    "success": False,
                                    "error": error_msg,
                                    "status_code": status_code,
                                }

                            message = chunk_data.get("message")
                            if message and isinstance(message, dict):
                                content, reasoning = collect_ollama_message_parts(message)
                                if reasoning:
                                    reasoning_content += reasoning
                                    progress_count = len(full_content) + len(reasoning_content)
                                    pbar.set_generating(progress_count)
                                    pbar.update(progress_count)
                                if content:
                                    full_content += content
                                    progress_count = len(full_content) + len(reasoning_content)
                                    pbar.set_generating(progress_count)
                                    pbar.update(progress_count)
                                    if stream_callback:
                                        stream_callback(content)

                            if chunk_data.get("done", False):
                                success, final_content = finalize_ollama_content(
                                    full_content,
                                    reasoning_content,
                                    include_reasoning=include_reasoning,
                                )
                                if success:
                                    pbar.done(
                                        char_count=len(final_content),
                                        elapsed_ms=int((time.perf_counter() - start_time) * 1000),
                                    )
                                    return {"success": True, "content": final_content}

                                return {
                                    "success": False,
                                    "error": describe_ollama_empty_content(full_content, reasoning_content),
                                    "status_code": 200,
                                    "reasoning": reasoning_content,
                                }
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            continue

                success, final_content = finalize_ollama_content(
                    full_content,
                    reasoning_content,
                    include_reasoning=include_reasoning,
                )
                if success:
                    return {"success": True, "content": final_content}
                return {
                    "success": False,
                    "error": describe_ollama_empty_content(full_content, reasoning_content),
                    "status_code": 200,
                    "reasoning": reasoning_content,
                }

            async def monitor_interrupts(target_task: asyncio.Task) -> bool:
                while not target_task.done():
                    is_interrupted = False
                    if cancel_event is not None and cancel_event.is_set():
                        is_interrupted = True
                    else:
                        try:
                            from server import PromptServer
                            if (
                                hasattr(PromptServer.instance, "execution_interrupted")
                                and PromptServer.instance.execution_interrupted
                            ):
                                is_interrupted = True
                        except Exception:
                            pass

                    if is_interrupted:
                        target_task.cancel()
                        return True
                    await asyncio.sleep(0.1)
                return False

            request_payload = payload.copy()
            req_task = asyncio.create_task(request_once(request_payload))
            monitor_task = asyncio.create_task(monitor_interrupts(req_task))

            try:
                result = await req_task

                if should_retry_without_ollama_think(request_payload, result):
                    request_payload = request_payload.copy()
                    request_payload.pop("think", None)
                    if not monitor_task.done():
                        monitor_task.cancel()
                    req_task = asyncio.create_task(request_once(request_payload))
                    monitor_task = asyncio.create_task(monitor_interrupts(req_task))
                    result = await req_task

                if is_ollama_reasoning_only_response(result):
                    retry_payload = build_ollama_final_answer_retry_payload(payload)
                    if not monitor_task.done():
                        monitor_task.cancel()
                    req_task = asyncio.create_task(request_once(retry_payload))
                    monitor_task = asyncio.create_task(monitor_interrupts(req_task))
                    result = await req_task

                if not result.get("success") and not getattr(pbar, "_closed", False):
                    pbar.error(result.get("error", "Unknown Ollama error"))
                return result
            except asyncio.CancelledError:
                pbar.cancel(f"任务被中断 | 服务:{provider_label}")
                return {"success": False, "error": "任务被中断", "interrupted": True}
            except Exception as req_err:
                error_msg = OllamaNativeAdapter.format_request_error(req_err, provider_label, timeout)
                if pbar:
                    pbar.error(error_msg)
                return {"success": False, "error": error_msg}
            finally:
                if not monitor_task.done():
                    monitor_task.cancel()
        finally:
            pass
