import { app } from "../../../../scripts/app.js";
import { logger } from "./logger.js";
import { APIService } from "../services/api.js";

export const UI_LANGUAGE_SETTING_ID = "PromptAssistant.Settings.InterfaceLanguage";
export const UI_LANGUAGE_STORAGE_KEY = "PromptAssistant.Settings.InterfaceLanguage";

const SUPPORTED_LANGUAGES = new Set(["zh", "en", "zh-TW", "ja", "ko", "ar", "es", "fa", "fr", "pt-BR", "ru", "tr"]);

export const LANGUAGE_OPTIONS = [
    { text: "简体中文", value: "zh" },
    { text: "English", value: "en" },
    { text: "繁體中文", value: "zh-TW" },
    { text: "日本語", value: "ja" },
    { text: "한국어", value: "ko" },
    { text: "Русский", value: "ru" },
    { text: "Türkçe", value: "tr" },
    { text: "Español", value: "es" },
    { text: "Français", value: "fr" },
    { text: "Português", value: "pt-BR" },
    { text: "العربية", value: "ar" },
    { text: "فارسی", value: "fa" }
];
const LOCALE_CACHE = new Map();
const DOM_SKIP_SELECTOR = [
    "input",
    "textarea",
    "select",
    "option",
    "[contenteditable='true']",
    "[data-pa-no-i18n]",
    ".prompt-list-row",
    ".tab-title",
    ".tab-subtitle",
    ".service-tab-title",
    ".service-tab-subtitle",
    ".model-tag-name"
].join(",");

let currentLanguage = "zh";
let currentMessages = {};
let isToastPatched = false;
let stopGlobalLocalizationObserver = null;

export function normalizeUiLanguage(value) {
    return SUPPORTED_LANGUAGES.has(value) ? value : "zh";
}

export function getStoredUiLanguage() {
    try {
        return normalizeUiLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) || "zh");
    } catch {
        return "zh";
    }
}

export function getCurrentUiLanguage() {
    const settingValue = app?.ui?.settings?.getSettingValue?.(UI_LANGUAGE_SETTING_ID);
    if (SUPPORTED_LANGUAGES.has(settingValue)) {
        return settingValue;
    }
    return getStoredUiLanguage();
}

export function persistUiLanguage(value) {
    const normalized = normalizeUiLanguage(value);
    try {
        localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalized);
    } catch { }
    return normalized;
}

async function fetchUiLocale(language) {
    const apiUrl = APIService.getApiUrl(`/config/ui_locale/${language}`);
    try {
        const apiResponse = await fetch(apiUrl, { cache: "no-cache" });
        if (apiResponse.ok) {
            const payload = await apiResponse.json();
            if (payload && payload.success && payload.messages && typeof payload.messages === "object") {
                return payload.messages;
            }
            if (payload && typeof payload === "object" && !payload.success) {
                throw new Error(payload.error || `Failed to load locale from API: ${language}`);
            }
        }
    } catch (error) {
        logger.warn(`[uiI18n] API locale fetch failed: ${error.message}`);
    }

    const localeUrl = new URL(`../../locales/${language}/ui.json`, import.meta.url);
    const response = await fetch(localeUrl.href, { cache: "no-cache" });
    if (!response.ok) {
        throw new Error(`Failed to load locale: ${language}`);
    }
    return await response.json();
}

/**
 * RU-FORK: английская база для фолбэка. Незнакомые ключи в русской (и любой
 * не-zh/en) локали показываются понятным английским, а не китайскими иероглифами.
 */
async function getEnglishFallbackMessages() {
    if (!LOCALE_CACHE.has("en")) {
        try {
            LOCALE_CACHE.set("en", await fetchUiLocale("en"));
        } catch (error) {
            logger.warn(`[uiI18n] ${error.message}`);
            return null;
        }
    }
    return LOCALE_CACHE.get("en") || null;
}

export async function ensureUiLocaleLoaded(force = false) {
    const language = getCurrentUiLanguage();
    if (!force && currentLanguage === language && currentMessages && Object.keys(currentMessages).length > 0) {
        return currentMessages;
    }

    if (!LOCALE_CACHE.has(language) || force) {
        try {
            LOCALE_CACHE.set(language, await fetchUiLocale(language));
        } catch (error) {
            logger.warn(`[uiI18n] ${error.message}`);
            if (language !== "zh") {
                try {
                    if (!LOCALE_CACHE.has("zh") || force) {
                        LOCALE_CACHE.set("zh", await fetchUiLocale("zh"));
                    }
                } catch (fallbackError) {
                    logger.warn(`[uiI18n] ${fallbackError.message}`);
                }
            }
        }
    }

    currentLanguage = language;

    // RU-FORK: непереведённые ключи -> английский текст (базовый слой),
    // вместо прежнего отката на китайский.
    let messages = LOCALE_CACHE.get(language);
    if (language !== "en" && language !== "zh") {
        const enBase = await getEnglishFallbackMessages();
        if (enBase) {
            messages = { ...enBase, ...(messages || {}) };
        }
    }

    currentMessages = messages || LOCALE_CACHE.get("zh") || {};
    return currentMessages;
}

function getTranslatedValue(key) {
    if (typeof key !== "string" || !key) return null;
    const translated = currentMessages?.[key];
    if (typeof translated === "string") {
        return translated;
    }
    return null;
}

export function tUI(key, fallback = undefined) {
    const translated = getTranslatedValue(key);
    if (translated !== null) {
        return translated;
    }
    return fallback ?? key;
}

function shouldSkipElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    return !!element.closest(DOM_SKIP_SELECTOR);
}

function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) return;

    const rawText = node.nodeValue;
    if (!rawText || !rawText.trim()) return;

    const trimmed = rawText.trim();
    const translated = getTranslatedValue(trimmed);
    if (!translated || translated === trimmed) return;

    const leading = rawText.match(/^\s*/)?.[0] ?? "";
    const trailing = rawText.match(/\s*$/)?.[0] ?? "";
    node.nodeValue = `${leading}${translated}${trailing}`;
}

function translateAttributes(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || shouldSkipElement(element)) return;
    ["placeholder", "title", "aria-label", "alt"].forEach((attr) => {
        const value = element.getAttribute(attr);
        if (!value) return;
        const translated = getTranslatedValue(value.trim());
        if (translated && translated !== value) {
            element.setAttribute(attr, translated);
        }
    });
}

export function localizeElement(root) {
    const lang = getCurrentUiLanguage();
    if (!root || lang === "zh" || !SUPPORTED_LANGUAGES.has(lang)) return;

    if (root.nodeType === Node.TEXT_NODE) {
        translateTextNode(root);
        return;
    }

    if (root.nodeType !== Node.ELEMENT_NODE) return;
    translateAttributes(root);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === Node.TEXT_NODE) {
            translateTextNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            translateAttributes(node);
        }
    }
}

export function observeLocalizedMutations(root) {
    const lang = getCurrentUiLanguage();
    if (!root || root.nodeType !== Node.ELEMENT_NODE || lang === "zh" || !SUPPORTED_LANGUAGES.has(lang)) {
        return () => { };
    }

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === "childList") {
                mutation.addedNodes.forEach((node) => {
                    localizeElement(node);
                });
            } else if (mutation.type === "attributes") {
                localizeElement(mutation.target);
            } else if (mutation.type === "characterData") {
                localizeElement(mutation.target);
            }
        });
    });

    observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ["placeholder", "title", "aria-label", "alt"]
    });

    return () => observer.disconnect();
}

export function syncGlobalUiLocalization() {
    if (typeof document === "undefined" || !document.body) return;

    if (typeof stopGlobalLocalizationObserver === "function") {
        stopGlobalLocalizationObserver();
        stopGlobalLocalizationObserver = null;
    }

    const lang = getCurrentUiLanguage();
    if (lang === "zh" || !SUPPORTED_LANGUAGES.has(lang)) return;

    localizeElement(document.body);
    stopGlobalLocalizationObserver = observeLocalizedMutations(document.body);
}

export function localizeToastPayload(payload) {
    if (!payload || typeof payload !== "object") {
        return payload;
    }

    const localized = { ...payload };
    ["summary", "detail", "message"].forEach((field) => {
        if (typeof localized[field] === "string") {
            localized[field] = tUI(localized[field], localized[field]);
        }
    });
    return localized;
}

export function patchToastLocalization() {
    if (isToastPatched) return;
    const toast = app?.extensionManager?.toast;
    if (!toast || typeof toast.add !== "function") return;

    const originalAdd = toast.add.bind(toast);
    toast.add = (payload) => originalAdd(localizeToastPayload(payload));
    isToastPatched = true;
}
