"""
Google Translate (публичный бесплатный эндпоинт, без API-ключа).

RU-FORK: добавлен по запросу пользователя как быстрый переводчик небольших
текстов ("типа гугл-переводчика"). Использует публичный эндпоинт
translate.googleapis.com/translate_a/single (client=gtx) — неофициальный,
без гарантий доступности и квот; при недоступности остаётся полноценный
путь через Ollama/L LM и встроенный Baidu.

Структура и возврат полностью зеркалят services/baidu.py, чтобы сервис
подключался в те же точки (нода, кнопка у текстовых полей, селектор).
"""

import asyncio
import json
import random
import time
from typing import Optional, Dict, Any

import httpx

from ..utils.common import ProgressBar, TASK_TRANSLATE, WARN_PREFIX

# Коды языков плагина -> коды Google Translate
_GOOGLE_LANG_MAP = {
    "auto": "auto",
    "en": "en",
    "ru": "ru",
    "zh": "zh-CN",
    "zh-tw": "zh-TW",
    "ja": "ja",
    "ko": "ko",
    "fr": "fr",
    "de": "de",
    "es": "es",
    "it": "it",
    "tr": "tr",
    "pt": "pt",
    "pt-br": "pt",
    "ar": "ar",
    "fa": "fa",
}

_ENDPOINT = "https://translate.googleapis.com/translate_a/single"


def map_lang_code(code: str) -> str:
    """Код языка плагина -> код Google Translate (pure, покрыто тестами)."""
    if not code:
        return "auto"
    return _GOOGLE_LANG_MAP.get(str(code).lower(), str(code).lower())


def parse_single_response(data) -> str:
    """Разобрать ответ translate_a/single (pure, покрыто тестами).

    Формат: [[[("перевод", "исходник", None, ...), ...], ...], ...]
    Перевод — конкатенация data[0][i][0].
    """
    if not isinstance(data, list) or not data or not isinstance(data[0], list):
        raise ValueError("Google: неожиданный формат ответа")
    parts = []
    for seg in data[0]:
        if isinstance(seg, list) and seg and isinstance(seg[0], str):
            parts.append(seg[0])
    if not parts:
        raise ValueError("Google: перевод не найден в ответе")
    return "".join(parts)


class GoogleTranslateService:
    @staticmethod
    def split_text_by_paragraphs(text, max_length=1200):
        """Разбить длинный текст по абзацам (как в BaiduTranslateService)."""
        if not text:
            return []
        lines = text.split('\n')
        chunks = []
        current_chunk = ""
        for line in lines:
            if len(line) > max_length:
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = ""
                remaining = line
                while len(remaining) > 0:
                    chunks.append(remaining[:max_length])
                    remaining = remaining[max_length:]
            elif current_chunk and (len(current_chunk) + len(line) + 1 > max_length):
                chunks.append(current_chunk)
                current_chunk = line
            else:
                if current_chunk:
                    current_chunk += "\n" + line
                else:
                    current_chunk = line
        if current_chunk:
            chunks.append(current_chunk)
        return chunks

    @staticmethod
    async def translate_chunk(client, chunk, from_lang, to_lang, retry_count=2):
        """Перевести один блок с повторными попытками."""
        last_err = None
        for attempt in range(retry_count):
            try:
                resp = await client.get(
                    _ENDPOINT,
                    params={
                        "client": "gtx",
                        "sl": from_lang,
                        "tl": to_lang,
                        "dt": "t",
                        "q": chunk,
                    },
                )
                if resp.status_code == 429:
                    raise Exception("Google: слишком много запросов (429), попробуйте позже")
                if resp.status_code != 200:
                    raise Exception(f"Google: HTTP {resp.status_code}")
                return parse_single_response(resp.json())
            except ValueError as e:
                # ошибка формата ответа — ретрай бессмысленен
                raise Exception(str(e))
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                last_err = e
                if attempt < retry_count - 1:
                    print(f"\r{WARN_PREFIX} Google Translate: сетевая ошибка, повтор "
                          f"({attempt + 1}/{retry_count}): {type(e).__name__}")
                    await asyncio.sleep(1)
            except Exception as e:
                last_err = e
                if attempt < retry_count - 1:
                    await asyncio.sleep(1)
        raise Exception(f"Google: {last_err or 'запрос не выполнен'}")

    @staticmethod
    async def translate(text, from_lang='auto', to_lang='zh', request_id=None,
                        is_auto=False, cancel_event=None, task_type=None, source=None):
        """Перевести текст (сигнатура и возврат — как у BaiduTranslateService.translate)."""
        pbar = None
        try:
            request_id = request_id or f"google_trans_{int(time.time())}_{random.randint(1000, 9999)}"
            if not text or not text.strip():
                return {"success": False, "error": "Google: 待翻译文本不能为空 (пустой текст)"}

            task_type = task_type or TASK_TRANSLATE
            g_from = map_lang_code(from_lang)
            g_to = map_lang_code(to_lang)
            if g_from == g_to and g_from != "auto":
                return {"success": False, "error": f"Google: исходный и целевой язык совпадают ({g_to})"}

            text_chunks = GoogleTranslateService.split_text_by_paragraphs(text) or [text]

            from ..server import is_streaming_progress_enabled
            pbar = ProgressBar(
                request_id=request_id,
                service_name="Google Translate",
                streaming=is_streaming_progress_enabled(),
                extra_info=f"长度:{len(text)}",
                task_type=task_type,
                source=source,
            )
            start_time = time.perf_counter()

            translated_parts = []
            # env-прокси включены: в отличие от Baidu, доступ к Google может требовать
            # системный прокси; таймаут умеренный, ретраи внутри translate_chunk
            async with httpx.AsyncClient(timeout=15.0) as client:
                for i, chunk in enumerate(text_chunks):
                    is_interrupted = False
                    if cancel_event is not None and cancel_event.is_set():
                        is_interrupted = True
                    else:
                        try:
                            from server import PromptServer
                            if hasattr(PromptServer.instance, 'execution_interrupted') and PromptServer.instance.execution_interrupted:
                                is_interrupted = True
                        except Exception:
                            pass
                    if is_interrupted:
                        pbar.cancel(f"{WARN_PREFIX} 任务被中断 | 服务:Google Translate")
                        return {"success": False, "error": "任务被中断", "interrupted": True}

                    try:
                        translated_parts.append(
                            await GoogleTranslateService.translate_chunk(client, chunk, g_from, g_to)
                        )
                        if i < len(text_chunks) - 1:
                            await asyncio.sleep(0.5)  # вежливая пауза против 429
                    except Exception as chunk_error:
                        pbar.error(str(chunk_error))
                        return {"success": False, "error": str(chunk_error)}

            translated_text = '\n'.join(translated_parts)
            elapsed = int((time.perf_counter() - start_time) * 1000)
            pbar.done(char_count=len(translated_text), elapsed_ms=elapsed)
            return {
                "success": True,
                "data": {
                    "translated": translated_text,
                    "from": from_lang,
                    "to": to_lang,
                    "original": text,
                },
            }
        except asyncio.CancelledError:
            if pbar:
                pbar.cancel(f"{WARN_PREFIX} 任务被外部取消 | 服务:Google Translate")
            return {"success": False, "error": "任务被取消", "interrupted": True}
        except Exception as e:
            if pbar:
                pbar.error(str(e))
            return {"success": False, "error": str(e)}
