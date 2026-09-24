"""
提示词增强节点 - V3 版本

V3 迁移说明：
    - 继承 LLMNodeBase（工具基类 Mixin）+ io.ComfyNode（V3 节点基类）
    - INPUT_TYPES → define_schema()，返回 io.Schema
    - IS_CHANGED → fingerprint_inputs()
    - def enhance(self, ...) → @classmethod execute(cls, ...)
    - 返回 io.NodeOutput(val) 代替 (val,)
    - hidden unique_id 通过 cls.hidden.unique_id 访问
    - 不再导出 NODE_CLASS_MAPPINGS，由顶层 __init__.py 的 ComfyExtension 统一注册
"""

import hashlib

from comfy.model_management import InterruptProcessingException
from comfy_api.latest import io

from ..services.codex_cli import CodexCLIService
from ..services.llm import LLMService
from ..utils.common import (
    format_api_error, format_model_with_thinking, generate_request_id,
    log_prepare, log_error, TASK_EXPAND, SOURCE_NODE
)
from ..services.thinking_control import build_thinking_suppression
from .base import LLMNodeBase


class PromptExpand(LLMNodeBase, io.ComfyNode):
    """
    提示词增强节点（V3）
    - 输入 "source_text"，根据所选规则模板或自定义规则进行增强/扩写
    - 仅包含一个字符串输入和一个字符串输出
    """

    @classmethod
    def define_schema(cls):
        """定义节点 Schema（V3 替代 INPUT_TYPES + 类属性）"""
        # 从 config_manager 获取系统提示词配置
        from ..config_manager import config_manager
        system_prompts = config_manager.get_system_prompts()

        # 获取所有 expand_prompts 作为下拉选项
        expand_prompts = {}
        active_expand_id = None
        if system_prompts:
            expand_prompts = system_prompts.get('expand_prompts', {}) or {}
            active_expand_id = system_prompts.get('active_prompts', {}).get('expand')

        # 构建提示词模板选项（支持分类格式：类别/规则名称）
        prompt_template_options = []
        id_to_display_name = {}
        for key, value in expand_prompts.items():
            # 过滤掉不在后端显示的规则
            show_in = value.get('showIn', ["frontend", "node"])
            if 'node' not in show_in:
                continue
            name = value.get('name', key)
            category = value.get('category', '')
            display_name = f"{category}/{name}" if category else name
            id_to_display_name[key] = display_name
            prompt_template_options.append(display_name)

        # 默认选项回退
        default_template_name = prompt_template_options[0] if prompt_template_options else "扩写-自然语言"
        if active_expand_id and active_expand_id in id_to_display_name:
            default_template_name = id_to_display_name[active_expand_id]

        if not prompt_template_options:
            prompt_template_options = ["扩写-自然语言"]

        # ---动态获取 LLM 服务/模型列表---
        service_options = cls.get_llm_service_options()
        default_service = service_options[0] if service_options else "智谱"

        return io.Schema(
            node_id="PromptExpand",
            display_name="✨Prompt Enhance",
            category="✨Prompt Assistant",
            description="Enhance and expand prompts using LLM services",
            inputs=[
                # 规则模板：来自系统配置的所有扩写规则
                io.Combo.Input(
                    "rule",
                    options=prompt_template_options,
                    default=default_template_name,
                    tooltip="Choose a preset rule for prompt enhancement",
                ),
                # 临时规则开关
                io.Boolean.Input(
                    "custom_rule",
                    default=False,
                    label_on="Enable",
                    label_off="Disable",
                    tooltip="Enable to use custom rule content below instead of preset",
                ),
                # 临时规则内容输入框
                io.String.Input(
                    "custom_rule_content",
                    multiline=True,
                    default="",
                    placeholder="Enter custom rule here, only effective when 'Custom Rule' is enabled",
                    tooltip="Enter your custom rule content here",
                ),
                # 用户提示词
                io.String.Input(
                    "user_prompt",
                    multiline=True,
                    default="",
                    placeholder="Enter the prompt to enhance; if source_text is also connected, both will be merged",
                    tooltip="The original prompt to enhance",
                ),
                # 扩写服务
                io.Combo.Input(
                    "llm_service",
                    options=service_options,
                    default=default_service,
                    tooltip="Select LLM service and model",
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
                # 原文输入端口（可选），默认为连接端口
                io.String.Input(
                    "source_text",
                    optional=True,
                    multiline=True,
                    default="",
                    force_input=True,
                    placeholder="Input text to enhance...",
                    tooltip="Optional input text",
                ),
                io.Combo.Input(
                    "codex_model",
                    options=CodexCLIService.get_model_options(),
                    default=CodexCLIService.SERVICE_MODEL,
                    tooltip="Codex CLI only. Override the model selected by the service.",
                ),
                io.Combo.Input(
                    "codex_reasoning_effort",
                    options=CodexCLIService.get_effort_options(),
                    default=CodexCLIService.DEFAULT_EFFORT,
                    tooltip="Codex CLI only. Use the model default or choose a reasoning effort.",
                ),
            ],
            outputs=[
                io.String.Output("enhanced_text"),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(
        cls,
        rule=None, custom_rule=None, custom_rule_content=None,
        user_prompt=None, llm_service=None, ollama_auto_unload=None,
        seed=None, source_text=None,
        codex_model=CodexCLIService.SERVICE_MODEL,
        codex_reasoning_effort=CodexCLIService.DEFAULT_EFFORT
    ):
        """
        替代 V1 IS_CHANGED，只在输入内容真正变化时才触发重新执行
        使用输入参数的哈希值作为判断依据
        """
        text_hash = hashlib.md5(((source_text or "")).encode('utf-8')).hexdigest()
        temp_rule_hash = hashlib.md5((custom_rule_content or "").encode('utf-8')).hexdigest()
        user_hint_hash = hashlib.md5((user_prompt or "").encode('utf-8')).hexdigest()

        input_hash = hash((
            rule,
            bool(custom_rule),
            temp_rule_hash,
            user_hint_hash,
            llm_service,
            bool(ollama_auto_unload),
            seed,
            text_hash,
            codex_model,
            codex_reasoning_effort,
        ))
        return input_hash

    @classmethod
    def execute(
        cls,
        rule, custom_rule, custom_rule_content, user_prompt,
        llm_service, ollama_auto_unload, seed=None, source_text=None,
        codex_model=CodexCLIService.SERVICE_MODEL,
        codex_reasoning_effort=CodexCLIService.DEFAULT_EFFORT
    ):
        """
        增强/扩写文本函数（V3 classmethod 版本）
        通过 cls.hidden.unique_id 访问节点唯一 ID
        """
        # 从 cls.hidden 获取节点唯一 ID
        unique_id = cls.hidden.unique_id
        request_id = None

        try:
            # 允许原文为空，但原文与用户提示词至少有一项非空
            source_text = (source_text or "").strip()
            user_prompt = (user_prompt or "").strip()
            if not source_text and not user_prompt:
                return io.NodeOutput("")

            # ---准备系统提示词（规则）---
            system_message = None
            rule_name = "Custom Rule" if (custom_rule and custom_rule_content) else rule

            if custom_rule and custom_rule_content:
                # 使用临时规则
                system_message = {"role": "system", "content": custom_rule_content}
            else:
                # 使用模板：从 config_manager 获取系统提示词配置
                from ..config_manager import config_manager
                system_prompts = config_manager.get_system_prompts()
                expand_prompts = system_prompts.get('expand_prompts', {}) if system_prompts else {}

                # 查找选定的提示词模板（按显示名称匹配）
                template_found = False
                for key, value in expand_prompts.items():
                    name = value.get('name', key)
                    category = value.get('category', '')
                    display_name = f"{category}/{name}" if category else name
                    if display_name == rule:
                        system_message = {"role": value.get('role', 'system'), "content": value.get('content', '')}
                        template_found = True
                        break
                if not template_found:
                    # 允许用规则名称或键名直接匹配（兼容旧格式）
                    for key, value in expand_prompts.items():
                        if value.get('name') == rule or key == rule:
                            system_message = {"role": value.get('role', 'system'), "content": value.get('content', '')}
                            template_found = True
                            break
                if not template_found or not system_message or not system_message.get('content'):
                    # 回退到默认
                    system_message = {"role": "system", "content": "你是一名提示词扩写专家，请将用户给定文本扩写为更完整、更具可读性和可执行性的提示词。"}
                    rule_name = "Default Rule"

            # ---解析服务/模型字符串---
            service_id, model_name = cls.parse_service_model(llm_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {llm_service}")

            # ---获取服务配置---
            from ..config_manager import config_manager
            service = config_manager.get_service(service_id)
            if not service:
                raise ValueError(f"Service config not found: {llm_service}")

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
                raise ValueError(f"Service {llm_service} has no available models")

            provider_config = {
                'provider': service_id,
                'model': target_model.get('name', ''),
                'base_url': service.get('base_url', ''),
                'api_key': service.get('api_key', ''),
                'temperature': target_model.get('temperature', 0.7),
                'max_tokens': target_model.get('max_tokens', 1000),
                'top_p': target_model.get('top_p', 0.9),
            }

            if service.get('type') == 'codex_cli':
                if codex_model != CodexCLIService.SERVICE_MODEL:
                    provider_config['model'] = codex_model
                if codex_reasoning_effort != CodexCLIService.DEFAULT_EFFORT:
                    provider_config['codex_reasoning_effort'] = codex_reasoning_effort

            # Ollama 特殊处理：添加 auto_unload 配置
            if service.get('type') == 'ollama':
                provider_config['auto_unload'] = ollama_auto_unload

            # 生成请求 ID
            request_id = generate_request_id("exp", None, unique_id)

            # 合并原文与用户提示词（输入端口在前，节点内文本框在后）
            combined_text = (
                user_prompt if not source_text
                else (f"{source_text}\n\n{user_prompt}" if user_prompt else source_text)
            )

            # 检查是否关闭思维链
            model_full_name = provider_config.get('model')
            disable_thinking_enabled = service.get('disable_thinking', True)
            thinking_extra = build_thinking_suppression(service_id, model_full_name) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model_full_name, bool(thinking_extra))

            # 获取服务显示名称
            service_display_name = service.get('name', service_id)

            # 准备阶段日志
            log_prepare(TASK_EXPAND, request_id, SOURCE_NODE, service_display_name, model_display, rule_name, {"长度": len(combined_text)})

            # 检查 API 密钥和模型
            if not provider_config.get('model', ''):
                raise ValueError(f"Please configure model for {llm_service}")
            if cls._service_requires_api_key(service) and not provider_config.get('api_key', ''):
                raise ValueError(f"Please configure API key and model for {llm_service}")

            # 执行扩写（异步线程 + 可中断）
            result = cls._run_llm_task(
                LLMService.expand_prompt,
                service_id,
                prompt=combined_text,
                request_id=request_id,
                stream_callback=None,
                custom_provider=service_id,
                custom_provider_config=provider_config,
                system_message_override=system_message,
                task_type=TASK_EXPAND,
                source=SOURCE_NODE
            )

            if result and result.get('success'):
                expanded_text = result.get('data', {}).get('expanded', '').strip()
                if not expanded_text:
                    error_msg = 'API returned empty result'
                    log_error(TASK_EXPAND, request_id, error_msg, source=SOURCE_NODE)
                    raise RuntimeError(f"Enhancement failed: {error_msg}")
                # 结果阶段日志由服务层统一输出，节点层不再重复打印
                return io.NodeOutput(expanded_text)
            else:
                error_msg = result.get('error', 'Unknown error') if result else 'No result returned'
                if error_msg == "任务被中断":
                    raise InterruptProcessingException()
                log_error(TASK_EXPAND, request_id, error_msg, source=SOURCE_NODE)
                raise RuntimeError(f"Enhancement failed: {error_msg}")

        except InterruptProcessingException:
            # 不打印日志，由基类统一打印
            raise
        except Exception as e:
            error_msg = format_api_error(e, llm_service)
            log_error(TASK_EXPAND, request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Enhancement error: {error_msg}")
