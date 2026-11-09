"""
Языковое определение и карты языков (чистые функции, без зависимостей от ComfyUI).

Общая точка правды для node/translate_node.py и тестов.
Коды языков: en / ru / zh / auto — совместимы с services/llm.py (_LANG_NAMES).
"""

import re

# Диапазоны: кириллица (осн. + доп.), CJK (единая идеография), латиница
_CYRILLIC_RE = re.compile('[\u0400-\u04ff\u0500-\u052f]')
_CJK_RE = re.compile('[\u4e00-\u9fff\u3400-\u4dbf]')
_LATIN_RE = re.compile('[A-Za-z]')

# Коды языков, поддерживаемые переводчиком
SUPPORTED_CODES = ('en', 'ru', 'zh', 'auto')

# Целевые языки ноды ✨Prompt Translate. Значения Combo сериализуются в
# workflow "как есть" (V3 io.Combo хранит строку-значение), поэтому
# исторические "English"/"Chinese" сохранены, "Russian" добавлена опцией.
# Локализованные подписи задаются в locales/*/nodeDefs.json.
TARGET_LANGUAGE_CODES = {
    'English': 'en',
    'Russian': 'ru',
    'Chinese': 'zh',
}

# Человекочитаемые имена для логов сервера (консольная локаль плагина — zh)
LANG_NAME_MAP = {
    'zh': '中文',
    'en': '英文',
    'ru': '俄语',
    'auto': '原文',
}


def contains_cyrillic(text: str) -> bool:
    return bool(text) and bool(_CYRILLIC_RE.search(text))


def contains_cjk(text: str) -> bool:
    return bool(text) and bool(_CJK_RE.search(text))


def detect_language(text: str) -> str:
    """Определить код языка текста.

    Приоритет: zh -> ru -> en -> auto.
    Смешанный текст (например, русский с английскими терминами LoRA/VAE)
    определяется как ближайший доминирующий алфавит; неоднозначное — 'auto'.
    """
    if not text:
        return 'auto'

    has_cjk = bool(_CJK_RE.search(text))
    has_cyr = bool(_CYRILLIC_RE.search(text))
    has_lat = bool(_LATIN_RE.search(text))

    if has_cjk:
        return 'zh'
    if has_cyr:
        # Кириллица доминирует; латиница может быть терминами (LoRA, VAE)
        if has_lat:
            return 'auto'
        return 'ru'
    if has_lat:
        return 'en'
    # Ни одного алфавитного символа (цифры/пунктуация/эмодзи)
    return 'auto'


def resolve_target_language(target_language: str, code_map: dict) -> str:
    """Явно отобразить имя целевого языка в код.

    Неизвестное значение -> None (вызывающий код обязан вернуть понятную ошибку,
    а не молча подставлять 'zh').
    """
    if not isinstance(target_language, str):
        return None
    return code_map.get(target_language)
