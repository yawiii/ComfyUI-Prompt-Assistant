"""
LLM服务 - 重构版本
提供大语言模型的扩写和翻译功能
继承OpenAICompatibleService以复用通用逻辑
"""

import time
import asyncio
from typing import Optional, Dict, Any, List, Callable
from .openai_base import OpenAICompatibleService
from .thinking_filter import postprocess_model_output
from ..utils.common import (
    format_api_error, ProgressBar, log_complete, log_error,
    PREFIX, PROCESS_PREFIX, WARN_PREFIX, ERROR_PREFIX, format_elapsed_time,
    TASK_EXPAND, TASK_TRANSLATE
)
from .thinking_control import build_thinking_suppression, should_append_no_thinking_instruction


class LLMService(OpenAICompatibleService):
    """
    大语言模型服务
    支持提示词扩写和文本翻译
    """
    
    @staticmethod
    def _get_config() -> Dict[str, Any]:
        """获取LLM配置"""
        from ..config_manager import config_manager
        config = config_manager.get_llm_config()
        current_provider = config.get('provider')

        if 'providers' in config and current_provider in config['providers']:
            provider_config = config['providers'][current_provider]
            return {
                'provider': current_provider,
                'model': provider_config.get('model', ''),
                'base_url': provider_config.get('base_url', ''),
                'api_key': provider_config.get('api_key', ''),
                'temperature': provider_config.get('temperature', 0.7),
                'top_p': provider_config.get('top_p', 0.9),
                'max_tokens': provider_config.get('max_tokens', 2000),
                'auto_unload': provider_config.get('auto_unload', True)
            }
        else:
            return config
    
    @staticmethod
    def _is_chinese(text: str) -> bool:
        """判断文本是否包含中文"""
        return any('\u4e00' <= char <= '\u9fff' for char in text)

    @staticmethod
    def select_translate_rule(system_prompts_data: Optional[Dict[str, Any]], from_lang: str, to_lang: str) -> Optional[Dict[str, Any]]:
        """Выбрать правило перевода для направления (pure-функция, покрыта тестами).

        Приоритет:
        1. Активированное пользователем правило — если id отличается от дефолта "ZH"
           (пользователь явно выбрал правило в менеджере правил).
        2. Правило, именованное по направлению, например "EN_RU" / "RU_EN" —
           поставляется шаблоном форка и даёт строгий перевод для этих направлений.
        3. Дефолтное/первое доступное правило (поведение upstream).
        """
        if not isinstance(system_prompts_data, dict):
            return None
        translate_prompts = system_prompts_data.get("translate_prompts", {})
        if not isinstance(translate_prompts, dict) or not translate_prompts:
            return None

        active_prompts = system_prompts_data.get("active_prompts", {})
        active_id = active_prompts.get("translate", "ZH") if isinstance(active_prompts, dict) else "ZH"

        # 1. Явный пользовательский выбор (не дефолт)
        if active_id and active_id != "ZH" and active_id in translate_prompts:
            return translate_prompts[active_id]

        # 2. Правило под конкретное направление (EN_RU, RU_EN, ZH_EN, ...)
        direction_id = f"{str(from_lang).lower()}_{str(to_lang).lower()}".upper()
        if direction_id in translate_prompts:
            return translate_prompts[direction_id]

        # 3. Дефолт / первое доступное (upstream-поведение)
        if active_id in translate_prompts:
            return translate_prompts[active_id]
        return next(iter(translate_prompts.values()))

    @staticmethod
    def _builtin_translate_instruction(from_name: str, to_name: str) -> str:
        """Встроенная строгая инструкция перевода (фолбэк, когда ни одно правило
        не найдено — например, у установок, не получивших новые шаблоны)."""
        return (
            f"Role: You are a professional translator for AI image-generation prompts. "
            f"Translate the user's text from {from_name} into {to_name}.\n"
            f"Absolute rules:\n"
            f"1. Output ONLY the translation. No comments, no explanations, no prefixes, no quotes, no Markdown styling.\n"
            f"2. Do NOT translate or alter technical tokens: weights like (word:1.2), ((word)), [word], {{word}}, "
            f"file paths, URLs, model/LoRA/VAE/ControlNet names, and existing English technical terms (LoRA, VAE, checkpoint, embedding).\n"
            f"3. Preserve Markdown structure (code blocks, headings, bold, tables) in place.\n"
            f"4. Preserve the original style: full sentences stay sentences, comma-separated tags stay tags, "
            f"line breaks and paragraph order are preserved. Do not omit or truncate any part of the text.\n"
            f"5. Use standard half-width punctuation of the target language; do not invent details absent from the source.\n"
            f"6. If the text is already mostly in {to_name}, return it unchanged."
        )

    
    @staticmethod
    async def _call_ollama_native(
        model: str,
        messages: List[Dict[str, str]],
        temperature: float,
        top_p: float,
        max_tokens: int,
        base_url: str,
        stream_callback: Optional[Callable[[str], None]] = None,
        request_id: Optional[str] = None,
        provider_display_name: str = "Ollama",
        auto_unload: bool = True,
        enable_advanced_params: bool = False,
        thinking_extra: Optional[Dict[str, Any]] = None,
        filter_thinking_output: bool = True,
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: str = None
    ) -> Dict[str, Any]:
        """
        调用Ollama原生API（支持流式输出）
        用于支持智能上下文窗口和思维链控制
        
        参数:
            enable_advanced_params: 是否发送高级参数(temperature/top_p/num_predict)
            thinking_extra: 思维链控制参数
        """
        # ---初始化请求参数---
        
        try:
            start_time = time.perf_counter()
            _thinking_extra = thinking_extra  # 使用传入的参数
            _thinking_tag = "（已关闭思维链）" if _thinking_extra else ""
            
            # 计算基准 URL (确保移除 /v1 和末尾斜杠)
            native_base = base_url.rstrip('/') if base_url else 'http://localhost:11434'
            if native_base.endswith('/v1'):
                native_base = native_base[:-3].rstrip('/')
            
            # 智能动态上下文窗口计算 (Token估算策略: 中文0.7/char, 英文0.3/char -> 保守取 0.6/char)
            # 安全地计算输入长度 (包含 System Prompt 和 User Prompt，前提是都在 messages 中)
            input_char_len = 0
            for msg in messages:
                input_char_len += len(msg.get('content', '') or '')
            
            estimated_input_tokens = int(input_char_len * 0.6)
            
            # --- 智能预留策略 ---
            # 关键点：思考过程 (Thinking Process) 也占用 Output Token 额度
            # 1. 如果成功禁用了思维链 (_thinking_extra 非空) -> 安全
            # 2. 如果模型名明确包含 instruct/chat (通常无思考过程) -> 安全
            # 3. 其他未知模型 -> 假定可能存在思考过程，预留更多空间
            
            is_safe_standard_model = False
            if model:
                m = model.lower()
                if "instruct" in m or "chat" in m:
                    is_safe_standard_model = True

            if _thinking_extra or is_safe_standard_model: 
                # 已关闭思维链 OR 标准指令模型 -> 极致节省模式
                min_output = 512
                min_ctx = 1024
            else:
                # 未知/潜在思考模型 -> 安全能够模式 (为思考过程预留空间)
                min_output = 1024
                min_ctx = 2048
            
            # 任务类型预留
            output_reserve = max(min_output, int(estimated_input_tokens * 1.5))
            
            # 384为系统开销Buffer (System Prompt通常已在estimated_input_tokens中，这里是额外的安全余量)
            required_ctx = estimated_input_tokens + output_reserve + 384
            
            # 对齐到 1024 倍数
            # 限制在 [min_ctx, 32768] 范围内
            num_ctx = max(min_ctx, min(32768, required_ctx))
            num_ctx = ((num_ctx + 1023) // 1024) * 1024
            
            # 合并多条 System Message（Ollama 对多条 system 消息处理不佳）
            merged_messages = LLMService._merge_system_prompts(messages)
            
            # 构建请求（安全地构建messages列表）
            ollama_messages = []
            for msg in merged_messages:
                ollama_messages.append({
                    "role": msg.get('role', 'user'),
                    "content": msg.get('content', '')
                })
            
            # 构建基础请求体
            payload = {
                "model": model,
                "messages": ollama_messages,
                "stream": True
            }

            # RU-FORK(VRAM): при включённой авто-выгрузке Ollama освобождает модель
            # сразу после завершения ответа (keep_alive=0), а не держит её 5 минут
            # по умолчанию — исключает OOM при последующей загрузке диффузионной
            # модели. Пост-выгрузка _unload_ollama_model остаётся как страховка.
            if auto_unload:
                payload["keep_alive"] = 0
            
            # ---构建 options---
            # 基础参数：num_ctx（动态上下文窗口大小）
            options = {
                "num_ctx": num_ctx
            }
            
            # 高级参数：仅在用户启用时发送
            # 参数说明（基于 Ollama 官方文档）：
            # - temperature: 控制随机性，默认0.8，值越低输出越稳定
            # - top_p: 核采样，默认0.9，限制候选词概率范围
            # - num_predict: 最大生成Token数，默认-1（无限）
            if enable_advanced_params:
                options["temperature"] = temperature
                options["top_p"] = top_p
                options["num_predict"] = max_tokens
            
            payload["options"] = options
            
            # 添加思维链控制参数（如 think: true 或 think: false）
            if _thinking_extra:
                payload.update(_thinking_extra)
            
            from ..server import is_streaming_progress_enabled

            # Динамический таймаут: база 30s + за каждый 1000 токенов контекста 5s.
            # RU-FORK FIX: нижняя граница 60s была недостаточна для длинных переводов —
            # холодная загрузка модели (~20s) + prompt eval + генерация длинного ответа
            # легко превышают 60s (замер на RTX 4060 Ti: первый токен через 39s).
            estimated_timeout = 30.0 + (num_ctx / 1000) * 5.0
            final_timeout = min(600.0, max(180.0, estimated_timeout)) # 180s - 600s
            
            # 创建统一进度条（自动处理等待→生成→完成的完整生命周期）
            extra_info = f"Context:{num_ctx} | Timeout:{int(final_timeout)}s"
            pbar = ProgressBar(
                request_id=request_id,
                service_name=provider_display_name,
                extra_info=extra_info,
                streaming=is_streaming_progress_enabled(),
                task_type=task_type,
                source=source
            )
            
            start_time = time.perf_counter()
            
            try:
                from .ollama_native import OllamaNativeAdapter
                return await OllamaNativeAdapter.stream_chat(
                    model=model,
                    native_base=native_base,
                    payload=payload,
                    timeout=final_timeout,
                    pbar=pbar,
                    stream_callback=stream_callback,
                    cancel_event=cancel_event,
                    provider_label="Ollama",
                    include_reasoning=not filter_thinking_output,
                )
            finally:
                if auto_unload:
                    try:
                        await cls._unload_ollama_model(model, {"base_url": native_base, "auto_unload": True})
                    except:
                        pass
        
        # 关键修复：单独捕获外层 CancelledError，确保 pbar 被正确停止
        except asyncio.CancelledError:
            if 'pbar' in locals() and pbar:
                pbar.cancel(f"{WARN_PREFIX} 任务被外部取消 | 服务:Ollama")
            return {"success": False, "error": "任务被取消", "interrupted": True}
        
        except Exception as e:
            # 关键修复：确保 pbar 在异常时也被停止
            if 'pbar' in locals() and pbar:
                pbar.error(format_api_error(e, provider_display_name))
            return {"success": False, "error": format_api_error(e, provider_display_name)}
    
    @staticmethod
    async def expand_prompt(
        prompt: str,
        request_id: Optional[str] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
        custom_provider: Optional[str] = None,
        custom_provider_config: Optional[Dict[str, Any]] = None,
        system_message_override: Optional[Dict[str, str]] = None,
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        使用大语言模型扩写提示词
        
        参数:
            prompt: 要扩写的提示词
            request_id: 请求ID
            stream_callback: 流式输出的回调函数
            custom_provider: 自定义服务商
            custom_provider_config: 自定义配置
            system_message_override: 覆盖系统提示词
        
        返回:
            Dict: {"success": bool, "data": {"original": str, "expanded": str}, "error": str}
        """
        try:
            # 获取配置
            if custom_provider and custom_provider_config:
                provider = custom_provider
                api_key = custom_provider_config.get('api_key')
                model = custom_provider_config.get('model')
                temperature = custom_provider_config.get('temperature', 0.7)
                top_p = custom_provider_config.get('top_p', 0.9)
                max_tokens = custom_provider_config.get('max_tokens', 2000)
                base_url = custom_provider_config.get('base_url', '')
            else:
                config = LLMService._get_config()
                provider = config.get('provider', 'unknown')
                api_key = config.get('api_key')
                model = config.get('model')
                temperature = config.get('temperature', 0.7)
                top_p = config.get('top_p', 0.9)
                max_tokens = config.get('max_tokens', 2000)
                base_url = config.get('base_url', '')

            # 注：允许空API Key，支持无认证服务商（如deepinfra公开端点）
            if not model:
                return {"success": False, "error": "未配置模型名称"}

            provider_display_name = LLMService.get_provider_display_name(provider)
            


            from ..utils.common import REQUEST_PREFIX, PREFIX, format_model_with_thinking
            
            # 获取系统提示词
            if system_message_override and system_message_override.get('content'):
                system_message = system_message_override
                prompt_name = system_message.get('name', '节点自定义规则')
            else:
                from ..config_manager import config_manager
                system_prompts = config_manager.get_system_prompts()

                if not system_prompts or 'expand_prompts' not in system_prompts:
                    return {"success": False, "error": "提示词优化系统提示词加载失败"}

                active_prompt_id = system_prompts.get('active_prompts', {}).get('expand', 'expand_default')
                if active_prompt_id not in system_prompts['expand_prompts']:
                    if len(system_prompts['expand_prompts']) > 0:
                        active_prompt_id = list(system_prompts['expand_prompts'].keys())[0]
                    else:
                        return {"success": False, "error": "未找到可用的提示词优化系统提示词"}

                system_message = system_prompts['expand_prompts'][active_prompt_id]
                prompt_name = system_message.get('name', active_prompt_id)
            
            # 检查服务配置的disable_thinking参数,只有开启时才关闭思维链
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            
            # 始终调用 build_thinking_suppression，传递 disable_thinking 参数
            _thinking_extra = build_thinking_suppression(service.get('type', provider) if service else provider, model, disable_thinking=disable_thinking_enabled)
            thinking_disabled = _thinking_extra is not None and disable_thinking_enabled
            model_display = format_model_with_thinking(model, thinking_disabled)

            # 构建消息
            lang_content = "请用中文回答" if LLMService._is_chinese(prompt) else "Please answer in English."
            provider_type = service.get('type', provider) if service else provider
            if should_append_no_thinking_instruction(provider_type, model, disable_thinking_enabled):
                lang_content += " 请直接输出结果，不要包含任何思考过程、推理过程或 <think> 标签。"
            
            lang_message = {
                "role": "system",
                "content": lang_content
            }
            messages = [lang_message, system_message, {"role": "user", "content": prompt}]

            # 判断是否走原生 Ollama API：必须是 ollama 类型，且 base_url 不以 /v1 结尾或包含 /v1/
            is_native_ollama = False
            if service and service.get('type') == 'ollama':
                # 兼容 "http://xxx:11434/v1/" 或 "http://xxx:11434/v1"
                _url = base_url.rstrip('/')
                if not _url.endswith('/v1') and '/v1/' not in base_url:
                    is_native_ollama = True

            # Ollama走原生API
            if is_native_ollama:
                # 读取 Ollama 服务的配置
                enable_advanced_params = service.get('enable_advanced_params', False)
                filter_thinking_output = service.get('filter_thinking_output', True)
                effective_filter_thinking_output = filter_thinking_output or disable_thinking_enabled
                
                # 统一计算 native_base (确保移除 /v1 和末尾斜杠)
                native_base = base_url.rstrip('/')
                if native_base.endswith('/v1'):
                    native_base = native_base[:-3].rstrip('/')
                
                # 再次兜底
                if not native_base:
                    native_base = 'http://localhost:11434'

                # 提前计算auto_unload配置
                _cfg = {
                    'auto_unload': custom_provider_config.get('auto_unload', True) if custom_provider_config else config.get('auto_unload', True),
                    'base_url': native_base
                }
                auto_unload = _cfg['auto_unload']

                result = await LLMService._call_ollama_native(
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    base_url=base_url,
                    stream_callback=stream_callback,
                    request_id=request_id,
                    provider_display_name=provider_display_name,
                    auto_unload=auto_unload,
                    enable_advanced_params=enable_advanced_params,
                    thinking_extra=_thinking_extra,
                    filter_thinking_output=effective_filter_thinking_output,
                    cancel_event=cancel_event,
                    task_type=task_type or TASK_EXPAND,
                    source=source
                )
                
                if result["success"]:
                    success, content = postprocess_model_output(
                        result["content"],
                        filter_thinking_output=effective_filter_thinking_output,
                    )
                    
                    # 最终检查内容是否为空
                    if not success:
                        return {"success": False, "error": "API returned empty result after filtering reasoning content (Ollama native)"}
                    
                    return {
                        "success": True,
                        "data": {"original": prompt, "expanded": content}
                    }
                else:
                    return result

            # 其他服务走HTTP直连
            if not base_url:
                base_url = LLMService.get_provider_base_url(provider, custom_provider_config if custom_provider else None)
            
            # 检查disable_thinking、enable_advanced_params和filter_thinking_output配置
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            enable_advanced_params = service.get('enable_advanced_params', False) if service else False
            filter_thinking_output = service.get('filter_thinking_output', True) if service else True
            effective_filter_thinking_output = filter_thinking_output or disable_thinking_enabled
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            
            result = await LLMService._http_request_chat_completions(
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                thinking_extra=thinking_extra,
                enable_advanced_params=enable_advanced_params,
                stream_callback=stream_callback,
                request_id=request_id,
                provider_display_name=provider_display_name,
                cancel_event=cancel_event,
                task_type=task_type or TASK_EXPAND,
                source=source,
                filter_thinking_output=effective_filter_thinking_output
            )

            if result["success"]:
                success, content = postprocess_model_output(
                    result["content"],
                    filter_thinking_output=effective_filter_thinking_output,
                )
                
                # 最终检查内容是否为空
                if not success:
                    return {"success": False, "error": "API returned empty result after filtering reasoning content (Model only output thinking process)"}
                return {
                    "success": True,
                    "data": {"original": prompt, "expanded": content}
                }
            else:
                return result

        except Exception as e:
            return {"success": False, "error": format_api_error(e, "LLM服务")}
    
    @staticmethod
    async def translate(
        text: str,
        from_lang: str = 'auto',
        to_lang: str = 'zh',
        request_id: Optional[str] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
        custom_provider: Optional[str] = None,
        custom_provider_config: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        使用大语言模型翻译文本
        
        参数:
            text: 要翻译的文本
            from_lang: 源语言
            to_lang: 目标语言
            request_id: 请求ID
            stream_callback: 流式输出回调
            custom_provider: 自定义服务商
            custom_provider_config: 自定义配置
        
        返回:
            Dict: {"success": bool, "data": {"original": str, "translated": str}, "error": str}
        """
        try:
            # 获取配置（翻译使用专门的翻译服务配置）
            if custom_provider and custom_provider_config:
                provider = custom_provider
                api_key = custom_provider_config.get('api_key')
                model = custom_provider_config.get('model')
                temperature = custom_provider_config.get('temperature', 0.7)
                top_p = custom_provider_config.get('top_p', 0.9)
                max_tokens = custom_provider_config.get('max_tokens', 2000)
                base_url = custom_provider_config.get('base_url', '')
            else:
                # 使用翻译服务配置（而非LLM配置）
                from ..config_manager import config_manager
                config = config_manager.get_translate_config()
                provider = config.get('provider', 'unknown')
                api_key = config.get('api_key')
                model = config.get('model')
                temperature = config.get('temperature', 0.7)
                top_p = config.get('top_p', 0.9)
                max_tokens = config.get('max_tokens', 2000)
                base_url = config.get('base_url', '')

            # 注：允许空API Key，支持无认证服务商
            if not model:
                return {"success": False, "error": "未配置模型名称"}

            provider_display_name = LLMService.get_provider_display_name(provider)

            from ..config_manager import config_manager
            service = config_manager.get_service(provider)

            from ..utils.common import REQUEST_PREFIX, PREFIX, format_model_with_thinking
            
            # 检测是否关闭思维链
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            _thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            thinking_disabled = _thinking_extra is not None and disable_thinking_enabled
            model_display = format_model_with_thinking(model, thinking_disabled)

            # 正确修复(BUG-06): 从规则管理器读取用户自定义翻译提示词
            # translate_prompts 配置中包含 {src_lang}/{dst_lang} 占位符，运行时动态替换
            # 语言代码映射为自然语言名称，提升模型理解稳定性
            _LANG_NAMES = {
                "zh": "Simplified Chinese (简体中文)",
                "zh-tw": "Traditional Chinese (繁體中文)",
                "en": "English",
                "ja": "Japanese (日本語)",
                "ko": "Korean (한국어)",
                "fr": "French",
                "de": "German",
                "es": "Spanish",
                "ru": "Russian (Русский)",
                "ar": "Arabic",
                "pt": "Portuguese",
                "pt-br": "Brazilian Portuguese",
                "it": "Italian",
                "tr": "Turkish",
                "fa": "Persian (Farsi)",
                "auto": "the detected source language"
            }
            from_name = _LANG_NAMES.get(str(from_lang).lower(), from_lang)
            to_name = _LANG_NAMES.get(str(to_lang).lower(), to_lang)

            translate_instruction = None
            prompt_entry = None
            try:
                system_prompts_data = config_manager.get_system_prompts()
                # BUG-FIX(RU): раньше активное правило всегда было "ZH" и
                # игнорировало направление; теперь правило выбирается и по
                # направлению (EN_RU / RU_EN из шаблона), и по явной активации.
                prompt_entry = LLMService.select_translate_rule(system_prompts_data, from_lang, to_lang)
                if prompt_entry and prompt_entry.get("content"):
                    # 替换 {src_lang} / {dst_lang} 占位符为自然语言名称
                    translate_instruction = (
                        prompt_entry["content"]
                        .replace("{src_lang}", from_name)
                        .replace("{dst_lang}", to_name)
                    )
            except Exception as e:
                print(f"\n[PA] 读取翻译规则失败，使用默认提示词: {e}", flush=True)

            # 终极兜底：规则管理器读取失败或无可用规则时使用内置严格指令
            if not translate_instruction:
                translate_instruction = LLMService._builtin_translate_instruction(from_name, to_name)

            messages = [
                {"role": "system", "content": translate_instruction},
                {"role": "user", "content": text}
            ]


            # 判断是否走原生 Ollama API：必须是 ollama 类型，且 base_url 不以 /v1 结尾或包含 /v1/
            is_native_ollama = False
            if service and service.get('type') == 'ollama':
                # 兼容 "http://xxx:11434/v1/" 或 "http://xxx:11434/v1"
                _url = base_url.rstrip('/')
                if not _url.endswith('/v1') and '/v1/' not in base_url:
                    is_native_ollama = True

            # Ollama走原生API
            if is_native_ollama:
                # 读取 Ollama 服务的配置
                disable_thinking_enabled = service.get('disable_thinking', True)
                enable_advanced_params = service.get('enable_advanced_params', False)
                filter_thinking_output = service.get('filter_thinking_output', True)
                effective_filter_thinking_output = filter_thinking_output or disable_thinking_enabled
                _ollama_thinking_extra = build_thinking_suppression(service.get('type', provider) if service else provider, model) if disable_thinking_enabled else None
                
                # 统一计算 native_base (确保移除 /v1 和末尾斜杠)
                native_base = base_url.rstrip('/')
                if native_base.endswith('/v1'):
                    native_base = native_base[:-3].rstrip('/')
                
                # 再次兜底
                if not native_base:
                    native_base = 'http://localhost:11434'

                _cfg = {
                    'auto_unload': custom_provider_config.get('auto_unload', True) if custom_provider_config else config.get('auto_unload', True),
                    'base_url': native_base
                }
                auto_unload = _cfg['auto_unload']

                result = await LLMService._call_ollama_native(
                    model=model,
                    messages=[{"role": "system", "content": translate_instruction}, {"role": "user", "content": text}],
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    base_url=base_url,
                    stream_callback=stream_callback,
                    request_id=request_id,
                    provider_display_name=provider_display_name,
                    auto_unload=auto_unload,
                    enable_advanced_params=enable_advanced_params,
                    thinking_extra=_ollama_thinking_extra,
                    filter_thinking_output=effective_filter_thinking_output,
                    cancel_event=cancel_event,
                    task_type=task_type or TASK_TRANSLATE,
                    source=source
                )
                
                if result["success"]:
                    success, content = postprocess_model_output(
                        result["content"],
                        filter_thinking_output=effective_filter_thinking_output,
                    )
                    
                    # 最终检查
                    if not success:
                        return {"success": False, "error": "API returned empty result after filtering reasoning content (Ollama native)"}
                    
                    return {
                        "success": True,
                        "data": {"original": text, "translated": content}
                    }
                else:
                    return result

            # 其他服务走HTTP直连
            if not base_url:
                base_url = LLMService.get_provider_base_url(provider, custom_provider_config if custom_provider else None)
            
            # 检查enable_advanced_params和filter_thinking_output配置
            enable_advanced_params = service.get('enable_advanced_params', False) if service else False
            filter_thinking_output = service.get('filter_thinking_output', True) if service else True
            effective_filter_thinking_output = filter_thinking_output or disable_thinking_enabled
            thinking_extra = _thinking_extra # 复用前面计算好的 suppression
            
            result = await LLMService._http_request_chat_completions(
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                thinking_extra=thinking_extra,
                enable_advanced_params=enable_advanced_params,
                stream_callback=stream_callback,
                request_id=request_id,
                provider_display_name=provider_display_name,
                cancel_event=cancel_event,
                task_type=task_type or TASK_TRANSLATE,
                source=source,
                filter_thinking_output=effective_filter_thinking_output
            )

            if result["success"]:
                success, content = postprocess_model_output(
                    result["content"],
                    filter_thinking_output=effective_filter_thinking_output,
                )
                
                # 最终检查
                if not success:
                    return {"success": False, "error": "API returned empty result after filtering reasoning content"}
                return {
                    "success": True,
                    "data": {"original": text, "translated": content}
                }
            else:
                return result

        except Exception as e:
            return {"success": False, "error": format_api_error(e, "LLM服务")}
