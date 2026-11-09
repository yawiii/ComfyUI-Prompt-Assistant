# -*- coding: utf-8 -*-
"""
Тест доставки новых правил перевода (EN_RU / RU_EN) через мигратор шаблонов:
бамп __config_version должен добавлять новые правила, не трогая
пользовательские правила и активные привязки.

Запуск: python -m unittest discover -s tests -v
"""

import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

_PKG_NAME = "pa_fork_tests2"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [str(REPO_ROOT)]
    sys.modules[_PKG_NAME] = _pkg

migration_tool = importlib.import_module(f"{_PKG_NAME}.utils.migration_tool")

TEMPLATE = json.load(open(REPO_ROOT / "config" / "system_prompts_template.json", encoding="utf-8"))


class TestTemplateDeliversRuRules(unittest.TestCase):
    def test_template_contains_ru_rules(self):
        tp = TEMPLATE["translate_prompts"]
        self.assertIn("EN_RU", tp)
        self.assertIn("RU_EN", tp)
        self.assertIn("ZH", tp)
        self.assertEqual(TEMPLATE["__config_version"], "2.2")
        for key in ("EN_RU", "RU_EN"):
            content = tp[key]["content"]
            self.assertIn("{src_lang}", content)
            self.assertIn("{dst_lang}", content)
            # защита промпт-синтаксиса в правилах
            for token in ("(word:1.2)", "LoRA", "Markdown"):
                self.assertIn(token, content)

    def test_migration_adds_rules_and_keeps_user_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rules_dir = tmp / "rules"
            rules_dir.mkdir(parents=True)

            # Пользовательская конфигурация со старой версией, кастомным
            # правилом и активной привязкой
            user = {
                "__config_version": "2.1",
                "translate_prompts": {
                    "ZH": {"role": "system", "content": "USER-EDITED ZH CONTENT"},
                    "my_custom": {"role": "system", "content": "my custom rule"},
                },
                "expand_prompts": {"expand_扩写-通用": {"name": "扩写-通用", "content": "x"}},
            }
            user_file = rules_dir / "system_prompts.json"
            with open(user_file, "w", encoding="utf-8") as f:
                json.dump(user, f, ensure_ascii=False)

            tool = migration_tool.MigrationTool(
                plugin_dir=str(REPO_ROOT),
                user_base_dir=str(tmp),
            )
            updated = tool._update_json_file(
                str(user_file),
                TEMPLATE,
                "system_prompts",
            )
            self.assertTrue(updated)

            with open(user_file, encoding="utf-8") as f:
                result = json.load(f)

            # Новые правила добавлены
            self.assertIn("EN_RU", result["translate_prompts"])
            self.assertIn("RU_EN", result["translate_prompts"])
            # Версия поднята
            self.assertEqual(result["__config_version"], "2.2")
            # Кастомное правило пользователя сохранено
            self.assertEqual(
                result["translate_prompts"]["my_custom"]["content"], "my custom rule"
            )
            # Прочие разделы пользователя сохранены
            self.assertIn("expand_prompts", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
