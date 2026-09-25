"""One-shot text generation through the locally installed Codex CLI."""

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..utils.common import ProgressBar


class CodexCLIService:
    SERVICE_MODEL = "Follow service"
    DEFAULT_EFFORT = "Model default"
    EFFORT_ORDER = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")

    @staticmethod
    def _find_executable() -> Optional[str]:
        configured = os.environ.get("PROMPT_ASSISTANT_CODEX_PATH", "").strip().strip('"')
        if configured:
            return shutil.which(configured)

        executable = shutil.which("codex")
        if executable:
            return executable

        if os.name == "nt":
            import winreg

            registry_paths = []
            for hive, key_name in (
                (winreg.HKEY_CURRENT_USER, "Environment"),
                (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
            ):
                try:
                    with winreg.OpenKey(hive, key_name) as key:
                        value, _ = winreg.QueryValueEx(key, "Path")
                    if isinstance(value, str):
                        registry_paths.append(os.path.expandvars(value))
                except OSError:
                    pass
            executable = shutil.which(
                "codex", path=os.pathsep.join([os.environ.get("PATH", ""), *registry_paths])
            )
            if executable:
                return executable

            local_appdata = Path(
                os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
            )
            bin_dir = local_appdata / "OpenAI" / "Codex" / "bin"
            try:
                return str(max(
                    (path for path in bin_dir.glob("*/codex.exe") if path.is_file()),
                    key=lambda path: path.stat().st_mtime,
                ))
            except (OSError, ValueError):
                pass
        return None

    @classmethod
    @lru_cache(maxsize=1)
    def _model_catalog(cls) -> Dict[str, Dict[str, Any]]:
        executable = cls._find_executable()
        if not executable:
            return {}
        try:
            result = subprocess.run(
                [executable, "debug", "models", "--bundled"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                check=False,
            )
            if result.returncode == 0:
                models = json.loads(result.stdout).get("models", [])
                return {
                    model["slug"]: model
                    for model in models
                    if model.get("slug") and model.get("visibility") == "list"
                }
        except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, AttributeError):
            pass
        return {}

    @classmethod
    def get_model_options(cls) -> List[str]:
        models = list(cls._model_catalog())
        if not models:
            models = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]
        return [cls.SERVICE_MODEL, "default", *models]

    @classmethod
    def get_effort_options(cls) -> List[str]:
        supported = {
            level.get("effort")
            for model in cls._model_catalog().values()
            for level in model.get("supported_reasoning_levels", [])
        }
        if not supported:
            supported = {"low", "medium", "high", "xhigh", "max"}
        return [cls.DEFAULT_EFFORT, *(level for level in cls.EFFORT_ORDER if level in supported)]

    @staticmethod
    def _build_prompt(messages: List[Dict[str, str]]) -> str:
        parts = [
            "Complete this text task using only the supplied text. "
            "Do not inspect files or use tools. Return only the requested final text."
        ]
        for message in messages:
            content = message.get("content", "").strip()
            if content:
                label = "Input" if message.get("role") == "user" else "Instructions"
                parts.append(f"{label}:\n{content}")
        return "\n\n".join(parts)

    @classmethod
    async def generate(
        cls,
        model: str,
        messages: List[Dict[str, str]],
        reasoning_effort: Optional[str] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
        request_id: Optional[str] = None,
        cancel_event: Optional[Any] = None,
        task_type: Optional[str] = None,
        source: Optional[str] = None,
    ) -> Dict[str, Any]:
        executable = cls._find_executable()
        if not executable:
            return {
                "success": False,
                "error": "未找到 Codex CLI；请检查本机安装，或设置 PROMPT_ASSISTANT_CODEX_PATH",
            }

        if reasoning_effort == cls.DEFAULT_EFFORT:
            reasoning_effort = None
        if reasoning_effort:
            if reasoning_effort not in cls.EFFORT_ORDER:
                return {"success": False, "error": f"无效的 Codex 思考强度：{reasoning_effort}"}
            catalog_model = cls._model_catalog().get(model)
            if catalog_model:
                supported = {
                    level.get("effort")
                    for level in catalog_model.get("supported_reasoning_levels", [])
                }
                if reasoning_effort not in supported:
                    return {
                        "success": False,
                        "error": f"{model} 不支持 {reasoning_effort} 思考强度",
                    }

        from ..server import is_streaming_progress_enabled

        pbar = ProgressBar(
            request_id=request_id,
            service_name="Codex CLI",
            streaming=is_streaming_progress_enabled(),
            task_type=task_type,
            source=source,
        )
        started = time.perf_counter()

        try:
            with tempfile.TemporaryDirectory(prefix="prompt-assistant-codex-") as workdir:
                answer_file = Path(workdir) / "answer.txt"
                command = [
                    executable, "--no-daemon", "--ask-for-approval", "never",
                ]
                if reasoning_effort:
                    command.extend([
                        "--config", f'model_reasoning_effort="{reasoning_effort}"'
                    ])
                command.extend([
                    "exec",
                    "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
                    "--sandbox", "read-only",
                    "--color", "never", "--output-last-message", str(answer_file),
                    "-C", workdir,
                ])
                if model and model.lower() != "default":
                    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", model):
                        pbar.error("Codex CLI 模型名称包含无效字符")
                        return {"success": False, "error": "Codex CLI 模型名称包含无效字符"}
                    command.extend(["--model", model])
                command.append("-")

                process = await asyncio.create_subprocess_exec(
                    *command,
                    cwd=workdir,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                communication = asyncio.create_task(
                    process.communicate(cls._build_prompt(messages).encode("utf-8"))
                )
                deadline = time.monotonic() + 300
                try:
                    while not communication.done():
                        if cancel_event is not None and cancel_event.is_set():
                            pbar.cancel("Codex CLI 任务被中断")
                            return {"success": False, "error": "任务被中断", "interrupted": True}
                        if time.monotonic() >= deadline:
                            pbar.error("Codex CLI 等待超时")
                            return {"success": False, "error": "Codex CLI 等待超过 300 秒"}
                        await asyncio.wait({communication}, timeout=0.2)

                    _, stderr = communication.result()
                    if process.returncode != 0:
                        detail = stderr.decode("utf-8", errors="replace").strip() or "未提供错误详情"
                        error = f"Codex CLI 运行失败（退出码 {process.returncode}）：{detail[-600:]}"
                        pbar.error(error)
                        return {"success": False, "error": error}

                    content = answer_file.read_text(encoding="utf-8").strip() if answer_file.exists() else ""
                    if not content:
                        pbar.error("Codex CLI 未返回文本")
                        return {"success": False, "error": "Codex CLI 未返回文本"}

                    if stream_callback:
                        stream_callback(content)
                    pbar.done(char_count=len(content), elapsed_ms=int((time.perf_counter() - started) * 1000))
                    return {"success": True, "content": content}
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                    if not communication.done():
                        communication.cancel()
                        await asyncio.gather(communication, return_exceptions=True)
        except asyncio.CancelledError:
            pbar.cancel("Codex CLI 任务被中断")
            raise
        except Exception as error:
            pbar.error(str(error))
            return {"success": False, "error": f"Codex CLI 调用失败：{error}"}
