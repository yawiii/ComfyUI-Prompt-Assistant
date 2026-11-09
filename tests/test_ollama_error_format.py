# -*- coding: utf-8 -*-
"""
Тесты форматирования ошибок Ollama-запроса (пустые сообщения таймаута и т.п.).
Запуск: python -m unittest discover -s tests -v
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

_PKG = "pa_fork_tests3"
if _PKG not in sys.modules:
    pkg = types.ModuleType(_PKG)
    pkg.__path__ = [str(REPO_ROOT)]
    sys.modules[_PKG] = pkg

httpx = importlib.import_module("httpx")  # для типов исключений
adapter_mod = importlib.import_module(f"{_PKG}.services.ollama_native")
OllamaNativeAdapter = adapter_mod.OllamaNativeAdapter


class TestFormatRequestError(unittest.TestCase):
    def test_timeout_error_gets_clear_message(self):
        # httpx.ReadTimeout имеет пустой str() — раньше лог был "请求异常:" без причины
        err = httpx.ReadTimeout("")
        msg = OllamaNativeAdapter.format_request_error(err, "Ollama", 180)
        self.assertIn("超时", msg)
        self.assertIn("timeout", msg.lower())
        self.assertIn("180", msg)
        self.assertNotIn(":", msg.rsplit("timeout", 1)[-1])  # нет пустого хвоста

    def test_asyncio_timeout(self):
        msg = OllamaNativeAdapter.format_request_error(asyncio.TimeoutError(), "Ollama", 60)
        self.assertIn("timeout", msg.lower())
        self.assertIn("60", msg)

    def test_named_error_keeps_message(self):
        err = ConnectionError("Все попытки подключения не удались")
        msg = OllamaNativeAdapter.format_request_error(err, "Ollama", 180)
        self.assertIn("ConnectionError", msg)
        self.assertIn("Все попытки подключения не удались", msg)

    def test_empty_message_falls_back_to_repr(self):
        err = ValueError()
        msg = OllamaNativeAdapter.format_request_error(err, "Ollama", 180)
        self.assertIn("ValueError", msg)
        self.assertTrue(len(msg) > len("Ollama 请求异常: "))


if __name__ == "__main__":
    unittest.main(verbosity=2)
