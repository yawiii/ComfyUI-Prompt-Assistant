# -*- coding: utf-8 -*-
"""
Тесты Google Translate сервиса: карта языков и парсер ответа (pure-функции).
Запуск: python -m unittest discover -s tests -v
"""

import importlib
import sys
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

_PKG = "pa_fork_tests4"
if _PKG not in sys.modules:
    pkg = types.ModuleType(_PKG)
    pkg.__path__ = [str(REPO_ROOT)]
    sys.modules[_PKG] = pkg


def _stub_module(name, **attrs):
    if name in sys.modules:
        return
    try:
        __import__(name)
        return
    except ImportError:
        pass
    stub = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(stub, k, v)
    sys.modules[name] = stub


_stub_module("httpx", AsyncClient=object, HTTPError=Exception, TimeoutException=Exception)
_stub_module("numpy", ndarray=object)
_stub_module("torch", Tensor=object)
_stub_module("imageio", imread=lambda *a, **k: None)
_stub_module("PIL", Image=object)
_stub_module("PIL.Image", Image=object)

gt = importlib.import_module(f"{_PKG}.services.google_translate")


class TestMapLangCode(unittest.TestCase):
    def test_basic_directions(self):
        self.assertEqual(gt.map_lang_code("en"), "en")
        self.assertEqual(gt.map_lang_code("ru"), "ru")

    def test_chinese_variants(self):
        self.assertEqual(gt.map_lang_code("zh"), "zh-CN")
        self.assertEqual(gt.map_lang_code("zh-tw"), "zh-TW")

    def test_auto_and_unknown(self):
        self.assertEqual(gt.map_lang_code("auto"), "auto")
        self.assertEqual(gt.map_lang_code(""), "auto")
        self.assertEqual(gt.map_lang_code(None), "auto")
        # неизвестный код передаётся как есть (Google сам ответит ошибкой)
        self.assertEqual(gt.map_lang_code("xx"), "xx")

    def test_case_insensitive(self):
        self.assertEqual(gt.map_lang_code("ZH"), "zh-CN")
        self.assertEqual(gt.map_lang_code("RU"), "ru")

    def test_pt_br(self):
        self.assertEqual(gt.map_lang_code("pt-br"), "pt")


class TestParseSingleResponse(unittest.TestCase):
    def test_typical_response(self):
        data = [
            [["Hello", "Привет", None, None, 10], [" world", " мир", None, None, 10]],
            None, "en",
        ]
        self.assertEqual(gt.parse_single_response(data), "Hello world")

    def test_single_sentence(self):
        # Реальный формат: data[0] — список сегментов [перевод, исходник, ...]
        data = [[["Привет мир", "Hello world", None, None, 10]], None, "en"]
        self.assertEqual(gt.parse_single_response(data), "Привет мир")

    def test_invalid_shapes_raise(self):
        for bad in (None, [], [[]], ["text"], [[None], None]):
            with self.assertRaises(ValueError):
                gt.parse_single_response(bad)

    def test_empty_segments_raise(self):
        with self.assertRaises(ValueError):
            gt.parse_single_response([[[]], None, "en"])


class TestSplitText(unittest.TestCase):
    def test_short_text_single_chunk(self):
        self.assertEqual(gt.GoogleTranslateService.split_text_by_paragraphs("привет"), ["привет"])

    def test_empty(self):
        self.assertEqual(gt.GoogleTranslateService.split_text_by_paragraphs(""), [])

    def test_long_text_chunked(self):
        text = ("абзац " * 500).strip()
        chunks = gt.GoogleTranslateService.split_text_by_paragraphs(text, max_length=1000)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertLessEqual(len(c), 1000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
