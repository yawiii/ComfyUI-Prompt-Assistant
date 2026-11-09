# Prompt Assistant — русская версия (fork impxiii)

Русифицированная версия плагина [Prompt Assistant](https://github.com/yawiii/ComfyUI-Prompt-Assistant)
для ComfyUI: полноценный перевод **EN → RU / RU → EN / ZH → RU** через локальную Ollama,
русский интерфейс и исправленное управление окнами.

> Лицензия: GNU GPL v3 (унаследована). Все заслуги оригинального автора — yawiii.

---

## 1. Что исправлено (кратко)

| Проблема | Статус |
|---|---|
| EN → RU переводил на китайский (и в ноде, и у кнопки в текстовом поле) | ✅ исправлено |
| Русский текст определялся неверно (RU → EN работал «случайно») | ✅ исправлено |
| `Russian` нельзя было выбрать в ноде ✨Prompt Translate | ✅ добавлено |
| Китайские иероглифы в русской локали (33 строки) | ✅ добавлены переводы + английский фолбэк |
| «Настройки» открывались под старым окном/подложкой, которые перехватывали клики | ✅ исправлено (управление слоями) |
| Зависание окон при переключении popup'ов (`ReferenceError`) | ✅ исправлено |
| Справка узлов не переводилась на русский | ✅ добавлено |

Подробности: [CHANGELOG_RU.md](CHANGELOG_RU.md), [docs/DIAGNOSIS_RU.md](docs/DIAGNOSIS_RU.md).

## 2. Требования

- ComfyUI (совместимо с теми же версиями, что и upstream; проверено на установленной схеме V3 API).
- Python-зависимости **не изменились** (`requirements.txt` не менялся).
- Для перевода: локальная [Ollama](https://ollama.com) с моделью `gemma4:e4b`
  (`ollama pull gemma4:e4b`). Платные API не требуются и не добавлялись.

## 3. Настройка Ollama / gemma4:e4b

1. Установите и запустите Ollama (по умолчанию `http://127.0.0.1:11434`).
2. `ollama pull gemma4:e4b`.
3. В ComfyUI откройте **Настройки → ✨Prompt Assistant → Конфигурация → API-менеджер**:
   - создайте/выберите сервис типа Ollama, адрес `http://127.0.0.1:11434`
     (без `/v1` в конце — тогда используется нативный API Ollama с авто-контекстом и
     выгрузкой модели из памяти);
   - добавьте модель `gemma4:e4b`, при желании включите «Отключить цепочку рассуждений» и
     «Авто-выгрузку модели»;
   - назначьте этот сервис для «Перевода» (и, при желании, для «Оптимизации»).
4. Рекомендуется выбрать инструкционную модель (`-instruct`/`-chat`) или держать включённой
   фильтрацию reasoning — иначе возможны вставки «размышлений» в перевод.

## 4. Установка на рабочий ComfyUI (переход с оригинала)

> ⚠️ **Не запускайте одновременно** оригинальный плагин и этот форк — конфликт регистрации
> JS и одинаковых имён нод. Перед началом закройте ComfyUI.

### Вариант A — через git (рекомендуется, легко откатывать)

```bash
# 1. Резервная копия текущей установки плагина (если он установлен как git-репо или папкой)
cd F:\1_ComfyUI_Main\custom_nodes
ren ComfyUI-Prompt-Assistant ComfyUI-Prompt-Assistant.bak

# 2. Клонировать форк
git clone https://github.com/impxiii/ComfyUI-Prompt-Assistant.git ComfyUI-Prompt-Assistant
cd ComfyUI-Prompt-Assistant
git checkout feature/russian-localization-ux
```

Настройки пользователя (API-ключи, правила, теги, история) хранятся **вне папки плагина**
(в `ComfyUI/user/default/prompt-assistant`) и при такой замене сохраняются автоматически.
При желании сделайте их резервную копию:

```bash
xcopy /E /I /H F:\1_ComfyUI_Main\user\default\prompt-assistant F:\backup\prompt-assistant-user-config
```

> Примечание: если вы вручную редактировали **встроенное** правило перевода `ZH`,
> заранее сохраните его содержимое как новое пользовательское правило — встроенные правила
> синхронизируются с шаблоном при обновлении (поведение upstream).

```bash
# 3. Зависимости (ничего нового не ставится)
cd F:\1_ComfyUI_Main
uv pip check --python .venv   # проверка окружения, только чтение
# запустить ComfyUI и смотреть лог на ошибки импорта плагина
```

### Вариант B — ZIP-архив

1. Скачайте архив ветки: `https://github.com/impxiii/ComfyUI-Prompt-Assistant/archive/refs/heads/feature/russian-localization-ux.zip`
2. Переименуйте/сдвиньте старую папку плагина (см. шаг 1 выше).
3. Распакуйте архив в `custom_nodes\ComfyUI-Prompt-Assistant` (имя папки должно остаться таким,
   чтобы ComfyUI грузил её вместо старой).

## 5. Использование перевода

**Нода ✨Prompt Translate:** поле `target_language` теперь содержит «Английский / Русский /
Китайский» (локализованные подписи; в JSON workflow по-прежнему хранятся `English`/`Russian`/
`Chinese`). Исходный язык определяется автоматически (ru/en/zh, смешанный текст — `auto`).

**Кнопка «Перевод» у текстовых полей:**
- при русском интерфейсе автоматически: английский → русский, китайский → русский,
  русский → английский;
- при желании зафиксируйте направление: **Настройки → ✨Prompt Assistant → Перевод →
  «Целевой язык кнопки перевода»** (Авто / На русский / На английский / На китайский);
- «Авто» при не-русском интерфейсе сохраняет прежнее поведение (zh ↔ en) — другие пользователи
  ничего не заметят.

**Правила перевода** (Настройки → «Правила»): появились встроенные строгие правила
`EN → RU (strict)` и `RU → EN (strict)`. Активация пользовательского правила имеет приоритет.
Переводимые технические токены защищены: `(tag:1.2)`, `((tag))`, `[tag]`, имена LoRA/моделей,
пути, Markdown.

## 6. Обновление форка / синхронизация с upstream

```bash
cd F:\Projects\ComfyUI-Prompt-Assistant-RU
git fetch upstream
git checkout feature/russian-localization-ux
git merge upstream/main        # или rebase, если история должна быть линейной
# разрешить конфликты при их появлении, затем:
git push origin feature/russian-localization-ux
```

## 7. Откат на оригинал (полный и безопасный)

```bash
# 1. Закрыть ComfyUI
# 2. Убрать форк
cd F:\1_ComfyUI_Main\custom_nodes
ren ComfyUI-Prompt-Assistant ComfyUI-Prompt-Assistant.fork-paused

# 3. Вернуть оригинал
ren ComfyUI-Prompt-Assistant.bak ComfyUI-Prompt-Assistant

# 4. (опционально) восстановить пользовательские конфиги из резервной копии
# rmdir /S /Q F:\1_ComfyUI_Main\user\default\prompt-assistant
# xcopy /E /I /H F:\backup\prompt-assistant-user-config F:\1_ComfyUI_Main\user\default\prompt-assistant
# 5. Запустить ComfyUI и проверить в логе загрузку плагина
```

Настройки, правила, теги и история совместимы в обе стороны: формат пользовательских
конфигов не менялся (добавляются только новые ключи шаблонов).

## 8. Разработка и тесты

```bash
git clone https://github.com/impxiii/ComfyUI-Prompt-Assistant.git
cd ComfyUI-Prompt-Assistant
git checkout feature/russian-localization-ux
python -m unittest discover -s tests -v   # 22 теста, без сторонних зависимостей
```

Документация разработки: [docs/DIAGNOSIS_RU.md](docs/DIAGNOSIS_RU.md) (причины и точки
изменений), [docs/UI_AUDIT_RU.md](docs/UI_AUDIT_RU.md) (аудит экранов),
[docs/TEST_REPORT_RU.md](docs/TEST_REPORT_RU.md) (что проверено и чек-лист ручной приёмки).
