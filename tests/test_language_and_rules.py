# -*- coding: utf-8 -*-
"""
Тесты Этапа B (P0 перевод): определение языка, карта целевых языков,
выбор правила перевода по направлению.

Запуск без ComfyUI и без сторонних зависимостей (только stdlib):
    python -m unittest discover -s tests -v
"""

import importlib
import sys
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


# ---Стабы pip-зависимостей, чтобы импортировать services.llm вне окружения ComfyUI---
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


_stub_module("httpx", Client=object, TimeoutException=Exception,
             HTTPStatusError=Exception, Response=object, AsyncClient=object)
_stub_module("numpy", ndarray=object, array=lambda *a, **k: None, asarray=lambda *a, **k: None)
_stub_module("torch", Tensor=object, float16=object, float32=object)
_stub_module("imageio", imread=lambda *a, **k: None)
_stub_module("PIL", Image=object)
_stub_module("PIL.Image", Image=object)

# ---Синтетический пакет-обёртка (позволяет относительные импорты services.*,
# не выполняя верхнеуровневый __init__.py плагина, которому нужен comfy_api)---
_PKG_NAME = "pa_fork_tests"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [str(REPO_ROOT)]
    sys.modules[_PKG_NAME] = _pkg

langutil = importlib.import_module(f"{_PKG_NAME}.utils.language")
llm_module = importlib.import_module(f"{_PKG_NAME}.services.llm")
LLMService = llm_module.LLMService


# ------------------------- utils.language.detect_language -------------------------

class TestDetectLanguage(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(langutil.detect_language(""), "auto")
        self.assertEqual(langutil.detect_language(None), "auto")

    def test_english(self):
        self.assertEqual(langutil.detect_language("masterpiece, best quality, 1girl"), "en")
        self.assertEqual(langutil.detect_language("A close-up photograph of a watch"), "en")

    def test_russian(self):
        self.assertEqual(langutil.detect_language("девушка с длинными волосами"), "ru")
        self.assertEqual(langutil.detect_language("Ночная улица, неоновые огни"), "ru")

    def test_chinese(self):
        self.assertEqual(langutil.detect_language("一个穿着红色裙子的女孩"), "zh")

    def test_russian_with_english_terms(self):
        # Русский с терминами LoRA/VAE — неоднозначный, но перевод НЕ должен блокироваться
        result = langutil.detect_language("девушка, LoRA: sawanopan, VAE fix")
        self.assertIn(result, ("auto", "ru"))

    def test_digits_only(self):
        self.assertEqual(langutil.detect_language("12345 , : 1.2"), "auto")


# ------------------------- карта целевых языков -------------------------

class TestTargetLanguageCodes(unittest.TestCase):
    def test_contains_three_targets(self):
        self.assertEqual(set(langutil.TARGET_LANGUAGE_CODES.keys()), {"English", "Russian", "Chinese"})

    def test_codes(self):
        self.assertEqual(langutil.TARGET_LANGUAGE_CODES, {"English": "en", "Russian": "ru", "Chinese": "zh"})

    def test_resolve_known(self):
        m = langutil.TARGET_LANGUAGE_CODES
        self.assertEqual(langutil.resolve_target_language("English", m), "en")
        self.assertEqual(langutil.resolve_target_language("Russian", m), "ru")
        self.assertEqual(langutil.resolve_target_language("Chinese", m), "zh")

    def test_resolve_unknown_never_silently_zh(self):
        # Ключевое требование ТЗ: неизвестное значение -> None -> ошибка, а не 'zh'
        self.assertIsNone(langutil.resolve_target_language("日本語", langutil.TARGET_LANGUAGE_CODES))
        self.assertIsNone(langutil.resolve_target_language("", langutil.TARGET_LANGUAGE_CODES))
        self.assertIsNone(langutil.resolve_target_language(None, langutil.TARGET_LANGUAGE_CODES))

    def test_old_workflow_values_still_supported(self):
        # Старые workflow содержат "English"/"Chinese" — обязаны продолжать работать
        m = langutil.TARGET_LANGUAGE_CODES
        self.assertIsNotNone(m.get("English"))
        self.assertIsNotNone(m.get("Chinese"))


# ------------------------- выбор правила перевода -------------------------

ZH_RULE = {"role": "system", "content": "ZH rule {src_lang} -> {dst_lang}"}
EN_RU_RULE = {"role": "system", "content": "EN to RU strict"}
RU_EN_RULE = {"role": "system", "content": "RU to EN strict"}


def make_data(active=None, prompts=None):
    data = {"translate_prompts": prompts if prompts is not None else {"ZH": ZH_RULE}}
    if active is not None:
        data["active_prompts"] = {"translate": active}
    return data


class TestSelectTranslateRule(unittest.TestCase):
    def test_none_data(self):
        self.assertIsNone(LLMService.select_translate_rule(None, "en", "ru"))
        self.assertIsNone(LLMService.select_translate_rule({}, "en", "ru"))

    def test_default_active_prefers_direction_rule(self):
        # Пользователь ничего не активировал (ZH по умолчанию) -> для en->ru берём EN_RU
        data = make_data(prompts={"ZH": ZH_RULE, "EN_RU": EN_RU_RULE, "RU_EN": RU_EN_RULE})
        self.assertIs(LLMService.select_translate_rule(data, "en", "ru"), EN_RU_RULE)
        self.assertIs(LLMService.select_translate_rule(data, "ru", "en"), RU_EN_RULE)

    def test_default_active_falls_back_to_zh_for_other_directions(self):
        # zh->en направления в шаблоне нет -> ZH (поведение upstream)
        data = make_data(prompts={"ZH": ZH_RULE, "EN_RU": EN_RU_RULE})
        self.assertIs(LLMService.select_translate_rule(data, "zh", "en"), ZH_RULE)

    def test_user_activation_has_priority(self):
        # Пользователь явно активировал своё правило -> оно главнее правил направления
        custom = {"role": "system", "content": "my custom rule"}
        data = make_data(active="my_custom", prompts={"ZH": ZH_RULE, "EN_RU": EN_RU_RULE, "my_custom": custom})
        self.assertIs(LLMService.select_translate_rule(data, "en", "ru"), custom)

    def test_direction_rule_without_active_key(self):
        data = {"translate_prompts": {"ZH": ZH_RULE, "EN_RU": EN_RU_RULE}}
        self.assertIs(LLMService.select_translate_rule(data, "en", "ru"), EN_RU_RULE)

    def test_missing_direction_and_active_missing_id(self):
        # Активный id не существует, правила направления нет -> первое доступное
        data = make_data(active="ghost", prompts={"ZH": ZH_RULE})
        self.assertIs(LLMService.select_translate_rule(data, "en", "ru"), ZH_RULE)

    def test_empty_prompts(self):
        self.assertIsNone(LLMService.select_translate_rule({"translate_prompts": {}}, "en", "ru"))


# ------------------------- встроенная инструкция -------------------------

class TestBuiltinInstruction(unittest.TestCase):
    def test_contains_language_names(self):
        instr = LLMService._builtin_translate_instruction("English", "Russian (Русский)")
        self.assertIn("Russian (Русский)", instr)
        self.assertNotIn("{dst_lang}", instr)
        self.assertNotIn("{src_lang}", instr)

    def test_protects_prompt_syntax(self):
        instr = LLMService._builtin_translate_instruction("English", "Russian")
        for token in ("(word:1.2)", "((word))", "[word]", "LoRA", "Markdown"):
            self.assertIn(token, instr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
