"""
提示词翻译节点 - V3 版本

V3 迁移说明：
    - 继承 LLMNodeBase（工具基类 Mixin）+ io.ComfyNode（V3 节点基类）
    - INPUT_TYPES → define_schema()，返回 io.Schema
    - IS_CHANGED → fingerprint_inputs()
    - def translate(self, ...) → @classmethod execute(cls, ...)
    - 原辅助实例方法全部转换为 @classmethod
    - 返回 io.NodeOutput(val) 代替 (val,)
    - hidden unique_id 通过 cls.hidden.unique_id 访问
    - 不再导出 NODE_CLASS_MAPPINGS，由顶层 __init__.py 的 ComfyExtension 统一注册
"""

import hashlib

from comfy.model_management import InterruptProcessingException
from comfy_api.latest import io

from ..services.llm import LLMService
from ..services.baidu import BaiduTranslateService
from ..utils.common import (
    format_api_error, format_model_with_thinking, generate_request_id,
    log_prepare, log_error, TASK_TRANSLATE, SOURCE_NODE
)
from ..services.thinking_control import build_thinking_suppression
from ..utils import language as langutil
from .base import LLMNodeBase


class PromptTranslate(LLMNodeBase, io.ComfyNode):
    """
    提示词翻译节点（V3）
    自动识别输入语言并翻译成目标语言，支持多种翻译服务
    """

    # Целевые языки: карта вынесена в utils/language.py (см. комментарий там)
    TARGET_LANGUAGE_CODES = langutil.TARGET_LANGUAGE_CODES

    @classmethod
    def define_schema(cls):
        """定义节点 Schema（V3 替代 INPUT_TYPES + 类属性）"""
        # ---动态获取翻译服务/模型列表（含硬编码的百度翻译）---
        service_options = cls.get_translate_service_options()
        default_service = service_options[0] if service_options else "百度翻译"

        return io.Schema(
            node_id="PromptTranslate",
            display_name="✨Prompt Translate",
            category="✨Prompt Assistant",
            description="Auto-detect input language and translate to target language",
            inputs=[
                io.String.Input(
                    "source_text",
                    force_input=True,
                    default="",
                    multiline=True,
                    placeholder="Input text to translate...",
                    tooltip="Text to translate",
                ),
                io.Combo.Input(
                    "target_language",
                    options=list(cls.TARGET_LANGUAGE_CODES.keys()),
                    default="English",
                ),
                io.Combo.Input(
                    "translate_service",
                    options=service_options,
                    default=default_service,
                    tooltip="Select translation service and model",
                ),
                # Ollama 自动释放显存
                io.Boolean.Input(
                    "ollama_auto_unload",
                    default=True,
                    label_on="Enable",
                    label_off="Disable",
                    tooltip="Auto unload Ollama model after generation",
                ),
                io.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xffffffffffffffff,
                    control_after_generate=True,
                ),
            ],
            outputs=[
                io.String.Output("translated_text"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(
        cls,
        source_text=None, target_language=None, translate_service=None,
        ollama_auto_unload=None, seed=None
    ):
        """
        替代 V1 IS_CHANGED，只在输入内容真正变化时才触发重新执行
        使用输入参数的哈希值作为判断依据
        """
        text_hash = ""
        if source_text:
            text_hash = hashlib.md5(source_text.encode('utf-8')).hexdigest()

        input_hash = hash((
            text_hash,
            target_language,
            translate_service,
            bool(ollama_auto_unload),
            seed
        ))
        return input_hash

    @classmethod
    def _contains_chinese(cls, text: str) -> bool:
        """检查文本是否包含中文字符"""
        return langutil.contains_cjk(text)

    @classmethod
    def _detect_language(cls, text: str) -> str:
        """自动检测文本语言 (zh / ru / en / auto)"""
        return langutil.detect_language(text)

    @classmethod
    def _translate_with_baidu(cls, text, from_lang, to_lang, service_name, from_lang_name, to_lang_name, unique_id):
        """使用百度翻译服务"""
        # 创建请求 ID
        request_id = generate_request_id("trans", "baidu", unique_id)

        # 准备阶段日志
        log_prepare(TASK_TRANSLATE, request_id, SOURCE_NODE, "百度翻译", None, None, {"方向": f"{from_lang_name}→{to_lang_name}", "长度": len(text)})

        # 执行翻译（异步线程 + 可中断）
        result = cls._run_llm_task(
            BaiduTranslateService.translate,
            service_name,
            text=text,
            from_lang=from_lang,
            to_lang=to_lang,
            request_id=request_id,
            task_type=TASK_TRANSLATE,
            source=SOURCE_NODE
        )
        return request_id, result

    @classmethod
    def _translate_with_llm(cls, text, from_lang, to_lang, service_id, model_name, service, service_display_name, from_lang_name, to_lang_name, auto_unload, unique_id):
        """使用 LLM 翻译服务"""
        # ---构建 provider_config---
        llm_models = service.get('llm_models', [])
        target_model = None

        if model_name:
            target_model = next((m for m in llm_models if m.get('name') == model_name), None)

        if not target_model:
            target_model = next(
                (m for m in llm_models if m.get('is_default')),
                llm_models[0] if llm_models else None
            )

        if not target_model:
            return None, {"success": False, "error": f"Service {service_display_name} has no available models"}

        provider_config = {
            'provider': service_id,
            'model': target_model.get('name', ''),
            'base_url': service.get('base_url', ''),
            'api_key': service.get('api_key', ''),
            'temperature': target_model.get('temperature', 0.7),
            'max_tokens': target_model.get('max_tokens', 1000),
            'top_p': target_model.get('top_p', 0.9),
        }

        # Ollama 特殊处理：添加 auto_unload 配置
        if service.get('type') == 'ollama':
            provider_config['auto_unload'] = auto_unload

        # 创建请求 ID
        request_id = generate_request_id("trans", "llm", unique_id)

        # 检查是否关闭思维链
        model_full_name = provider_config.get('model')
        disable_thinking_enabled = service.get('disable_thinking', True)
        thinking_extra = build_thinking_suppression(service_id, model_full_name) if disable_thinking_enabled else None
        model_display = format_model_with_thinking(model_full_name, bool(thinking_extra))

        # 获取服务显示名称
        service_display_name = service.get('name', service_id)

        # 准备阶段日志
        log_prepare(TASK_TRANSLATE, request_id, SOURCE_NODE, service_display_name, model_display, None, {"方向": f"{from_lang_name}→{to_lang_name}", "长度": len(text)})

        # 检查 API 密钥和模型
        api_key = provider_config.get('api_key', '')
        model = provider_config.get('model', '')

        if not model:
            return request_id, {"success": False, "error": f"Please configure model for {service_display_name}"}
        if cls._service_requires_api_key(service) and not api_key:
            return request_id, {"success": False, "error": f"Please configure API key and model for {service_display_name}"}

        # 执行翻译（异步线程 + 可中断）
        result = cls._run_llm_task(
            LLMService.translate,
            service_id,
            text=text,
            from_lang=from_lang,
            to_lang=to_lang,
            request_id=request_id,
            stream_callback=None,
            custom_provider=service_id,
            custom_provider_config=provider_config,
            task_type=TASK_TRANSLATE,
            source=SOURCE_NODE
        )
        return request_id, result

    @classmethod
    def execute(cls, source_text, target_language, translate_service, ollama_auto_unload, seed=None):
        """
        翻译文本函数（V3 classmethod 版本）
        通过 cls.hidden.unique_id 访问节点唯一 ID
        """
        # 从 cls.hidden 获取节点唯一 ID
        unique_id = cls.hidden.unique_id
        request_id = None

        try:
            # 检查输入
            if not source_text or not source_text.strip():
                return io.NodeOutput("")

            # 自动检测源语言
            detected_lang = cls._detect_language(source_text)

            # ---Явное отображение целевого языка (BUG-FIX: раньше всё, кроме
            # "English", молча становилось "zh")---
            to_lang = langutil.resolve_target_language(target_language, cls.TARGET_LANGUAGE_CODES)
            if to_lang is None:
                raise ValueError(
                    f"Unsupported target_language value: {target_language!r}. "
                    f"Expected one of: {', '.join(cls.TARGET_LANGUAGE_CODES.keys())}. "
                    "The workflow was probably saved with an incompatible plugin version."
                )

            # 智能跳过翻译逻辑
            skip_translation = False
            if to_lang == detected_lang and to_lang in ('en', 'zh', 'ru'):
                from ..utils.common import _ANSI_CLEAR_EOL
                lang_label = langutil.LANG_NAME_MAP.get(to_lang, to_lang)
                print(f"\r{_ANSI_CLEAR_EOL}{cls.REQUEST_PREFIX} 检测到{lang_label}输入，目标为{lang_label}，无需翻译", flush=True)
                skip_translation = True

            if skip_translation:
                return io.NodeOutput(source_text)

            # 映射语言名称
            lang_map = langutil.LANG_NAME_MAP
            from_lang_name = lang_map.get(detected_lang, detected_lang)
            to_lang_name = lang_map.get(to_lang, to_lang)

            # ---解析服务/模型字符串---
            service_id, model_name = cls.parse_service_model(translate_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {translate_service}")

            # ---百度翻译特殊处理---
            if service_id == 'baidu':
                request_id, result = cls._translate_with_baidu(
                    source_text, detected_lang, to_lang,
                    translate_service, from_lang_name, to_lang_name, unique_id
                )
            else:
                # ---LLM 翻译：获取服务配置---
                from ..config_manager import config_manager
                service = config_manager.get_service(service_id)
                if not service:
                    raise ValueError(f"Service config not found: {translate_service}")

                request_id, result = cls._translate_with_llm(
                    source_text, detected_lang, to_lang,
                    service_id, model_name, service,
                    translate_service, from_lang_name, to_lang_name,
                    ollama_auto_unload, unique_id
                )

            if result and result.get('success'):
                translated_text = result.get('data', {}).get('translated', '').strip()
                if not translated_text:
                    error_msg = 'API returned empty result'
                    raise RuntimeError(f"❌Translation failed: {error_msg}")
                # 结果阶段日志由服务层统一输出，节点层不再重复打印
                return io.NodeOutput(translated_text)
            else:
                error_msg = result.get('error', 'Unknown error') if result else 'No result returned'
                if error_msg == "任务被中断":
                    raise InterruptProcessingException()
                log_error(TASK_TRANSLATE, request_id, error_msg)
                raise RuntimeError(f"Translation failed: {error_msg}")

        except InterruptProcessingException:
            # 不打印日志，由基类统一打印
            raise
        except Exception as e:
            error_msg = format_api_error(e, translate_service)
            log_error(TASK_TRANSLATE, request_id, error_msg)
            raise RuntimeError(f"Translation error: {error_msg}")
