"""
图像反推（图片反推提示词）节点 - V3 版本

V3 迁移说明：
    - 继承 VLMNodeBase + io.ComfyNode
    - INPUT_TYPES → define_schema()
    - IS_CHANGED → fingerprint_inputs()
    - def analyze_image(self, ...) → @classmethod execute(cls, ...)

功能说明：
    - 支持单张图像输入
    - 支持多图输入（image2~image9 可选）：所有已连接的图像合并进一次 VLM 请求，输出一条综合描述
    - 支持 IMAGE batch 输入：逐帧独立调用 VLM，输出合并文本 + 字符串列表
    - 两个输出端口：
        · caption_text  (STRING)      - 所有帧结果用 "\\n---\\n" 合并的完整文本
        · caption_list  (STRING List) - 每帧独立结果的字符串列表（is_output_list=True）
"""

from comfy.model_management import InterruptProcessingException
from comfy_api.latest import io

from ..services.vlm import VisionService
from ..utils.common import (
    format_api_error, format_model_with_thinking, generate_request_id,
    log_prepare, log_error, TASK_IMAGE_CAPTION, SOURCE_NODE
)
from ..services.thinking_control import build_thinking_suppression
from .base import VLMNodeBase


class ImageCaptionNode(VLMNodeBase, io.ComfyNode):
    """图像反推节点（V3），支持单张/批量图像输入，输出合并文本与字符串列表"""

    @classmethod
    def define_schema(cls):
        # 动态获取服务列表
        service_options = cls.get_vlm_service_options()
        default_service = service_options[0] if service_options else "智谱"

        # 获取模板
        from ..config_manager import config_manager
        system_prompts = config_manager.get_system_prompts()

        vision_prompts = {}
        active_vision_id = None
        if system_prompts:
            vision_prompts = system_prompts.get('vision_prompts', {}) or {}
            active_vision_id = system_prompts.get('active_prompts', {}).get('vision')

        prompt_template_options = []
        id_to_display_name = {}
        for key, value in vision_prompts.items():
            show_in = value.get('showIn', ["frontend", "node"])
            if 'node' not in show_in:
                continue
            name = value.get('name', key)
            category = value.get('category', '')
            display_name = f"{category}/{name}" if category else name
            id_to_display_name[key] = display_name
            prompt_template_options.append(display_name)

        default_template_name = prompt_template_options[0] if prompt_template_options else "反推-自然语言"
        if active_vision_id and active_vision_id in id_to_display_name:
            default_template_name = id_to_display_name[active_vision_id]

        if not prompt_template_options:
            prompt_template_options = ["反推-自然语言"]

        return io.Schema(
            node_id="ImageCaptionNode",
            display_name="✨Image Caption (VLM)",
            category="✨Prompt Assistant",
            description="Extract text prompt from image using Vision-Language Models",
            inputs=[
                io.Image.Input(
                    "image",
                    tooltip="The image to analyze. Supports single image or IMAGE batch (processes each frame independently). Additional optional inputs image2~image9 are merged into ONE multi-image request"
                ),
                io.Image.Input(
                    "image2",
                    optional=True,
                    tooltip="Optional extra image. When connected, all images are sent to the VLM in ONE request and described together"
                ),
                io.Image.Input(
                    "image3",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Image.Input(
                    "image4",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Image.Input(
                    "image5",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Image.Input(
                    "image6",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Image.Input(
                    "image7",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Image.Input(
                    "image8",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Image.Input(
                    "image9",
                    optional=True,
                    tooltip="Optional extra image (merged into one multi-image request)"
                ),
                io.Combo.Input(
                    "rule",
                    options=prompt_template_options,
                    default=default_template_name,
                    tooltip="Choose a preset rule for analysis"
                ),
                io.Boolean.Input(
                    "custom_rule",
                    default=False,
                    label_on="Enable",
                    label_off="Disable",
                    tooltip="Enable custom rule input"
                ),
                io.String.Input(
                    "custom_rule_content",
                    multiline=True,
                    default="",
                    tooltip="Custom rule content, only used when Custom Rule is enabled"
                ),
                io.String.Input(
                    "user_prompt",
                    multiline=True,
                    default="",
                    tooltip="Enter additional prompts here, sent with the rule"
                ),
                io.Combo.Input(
                    "vlm_service",
                    options=service_options,
                    default=default_service,
                    tooltip="Select VLM Service"
                ),
                io.Boolean.Input(
                    "ollama_auto_unload",
                    default=True,
                    label_on="Enable",
                    label_off="Disable",
                    tooltip="Auto unload Ollama model after generation"
                ),
                io.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xffffffffffffffff,
                    control_after_generate=True,
                    tooltip="Controls randomness. Set to non-fixed mode to force re-execution"
                ),
            ],
            outputs=[
                # 合并文本（单张直接输出；batch 时用 "\n---\n" 拼接）
                io.String.Output("caption_text"),
                # 每帧独立结果列表（单张时为单元素列表）
                io.String.Output("caption_list", is_output_list=True),
            ],
            hidden=[io.Hidden.unique_id],
        )

    # -------------------------------------------------------------------------
    # fingerprint_inputs（替代 IS_CHANGED）
    # -------------------------------------------------------------------------

    @classmethod
    def fingerprint_inputs(
        cls,
        image=None, image2=None, image3=None, image4=None, image5=None,
        image6=None, image7=None, image8=None, image9=None,
        rule=None, custom_rule=None, custom_rule_content=None,
        user_prompt=None, vlm_service=None, ollama_auto_unload=None, seed=None
    ):
        """替代 V1 IS_CHANGED"""
        import hashlib
        temp_rule_hash = hashlib.md5((custom_rule_content or "").encode('utf-8')).hexdigest()
        user_hint_hash = hashlib.md5((user_prompt or "").encode('utf-8')).hexdigest()
        img_hash = cls._compute_image_hash(image)
        extra_img_hashes = tuple(
            cls._compute_image_hash(img) for img in (image2, image3, image4, image5, image6, image7, image8, image9)
        )

        return hash((
            img_hash,
            extra_img_hashes,
            rule,
            bool(custom_rule),
            temp_rule_hash,
            user_hint_hash,
            vlm_service,
            bool(ollama_auto_unload),
            seed
        ))

    # -------------------------------------------------------------------------
    # 内部辅助：分析单张图像
    # -------------------------------------------------------------------------

    @classmethod
    def _analyze_single_image(
        cls,
        image_data: str,
        prompt_to_send: str,
        rule_name: str,
        service_id: str,
        service: dict,
        provider_config: dict,
        request_id: str,
        frame_index=None
    ) -> str:
        """
        对单张图像调用 VLM 进行分析，返回文本结果。

        参数：
            image_data    : base64 编码的图像 data URL
            prompt_to_send: 拼接好的提示词（system + user_prompt）
            rule_name     : 当前规则名称（用于日志）
            service_id    : 服务 ID
            service       : 服务配置字典
            provider_config: API 调用参数字典
            request_id    : 本次请求 ID
            frame_index   : batch 模式下当前帧序号（None 表示单张模式）

        返回：
            分析结果文本字符串
        """
        frame_label = f" [Frame {frame_index + 1}]" if frame_index is not None else ""
        model_full_name = provider_config.get('model')
        disable_thinking_enabled = service.get('disable_thinking', True)
        thinking_extra = (
            build_thinking_suppression(service_id, model_full_name)
            if disable_thinking_enabled else None
        )
        model_display = format_model_with_thinking(model_full_name, bool(thinking_extra))
        service_display_name = service.get('name', service_id)

        log_prepare(
            TASK_IMAGE_CAPTION, request_id, SOURCE_NODE,
            service_display_name, model_display, rule_name + frame_label
        )

        result = cls._run_vision_task(
            VisionService.analyze_image,
            service_id,
            image_data=image_data,
            prompt_content=prompt_to_send,
            request_id=request_id,
            custom_provider=service_id,
            custom_provider_config=provider_config,
            source=SOURCE_NODE
        )

        if result and result.get('success'):
            data = result.get('data', {})
            # V3 重构后返回键名为 description，兼容旧版 caption
            caption_text = data.get('description', data.get('caption', '')).strip()
            if not caption_text:
                error_msg = 'API returned empty result'
                log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
                raise RuntimeError(f"Analysis failed: {error_msg}")
            return caption_text
        else:
            error_msg = (
                result.get('error', 'Unknown error') if result
                else 'No result returned'
            )
            if error_msg == "任务被中断":
                raise InterruptProcessingException()
            log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Analysis failed: {error_msg}")

    # -------------------------------------------------------------------------
    # execute（V3 主执行方法）
    # -------------------------------------------------------------------------

    @classmethod
    def execute(
        cls,
        image, rule, custom_rule, custom_rule_content,
        user_prompt, vlm_service, ollama_auto_unload,
        image2=None, image3=None, image4=None, image5=None,
        image6=None, image7=None, image8=None, image9=None,
        seed=None
    ):
        unique_id = cls.hidden.unique_id
        request_id = None

        try:
            if image is None:
                raise ValueError("No image provided. Please connect an image to the 'image' input.")

            # ------------------------------------------------------------------
            # 1. 构建提示词
            # ------------------------------------------------------------------
            rule_name = "Custom Rule" if (custom_rule and custom_rule_content) else rule
            system_message = None

            if custom_rule and custom_rule_content:
                system_message = {"role": "system", "content": custom_rule_content}
            else:
                from ..config_manager import config_manager
                system_prompts = config_manager.get_system_prompts()
                vision_prompts = system_prompts.get('vision_prompts', {}) if system_prompts else {}

                template_found = False
                for key, value in vision_prompts.items():
                    name = value.get('name', key)
                    category = value.get('category', '')
                    display_name = f"{category}/{name}" if category else name
                    if display_name == rule or value.get('name') == rule or key == rule:
                        system_message = {
                            "role": value.get('role', 'system'),
                            "content": value.get('content', '')
                        }
                        template_found = True
                        break

                if not template_found or not system_message or not system_message.get('content'):
                    system_message = {"role": "system", "content": "请详细描述这张图片的内容"}
                    rule_name = "Default Rule"

            system_text = (
                system_message.get('content', '')
                if isinstance(system_message, dict)
                else str(system_message)
            )
            prompt_to_send = f"{system_text}\n\n{user_prompt}".strip() if user_prompt else system_text

            # ------------------------------------------------------------------
            # 2. 解析服务与模型
            # ------------------------------------------------------------------
            service_id, model_name = cls.parse_service_model(vlm_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {vlm_service}")

            from ..config_manager import config_manager
            service = config_manager.get_service(service_id)
            if not service:
                raise ValueError(f"Service config not found: {vlm_service}")

            vlm_models = service.get('vlm_models', [])
            target_model = None
            if model_name:
                target_model = next((m for m in vlm_models if m.get('name') == model_name), None)
            if not target_model:
                target_model = next(
                    (m for m in vlm_models if m.get('is_default')),
                    vlm_models[0] if vlm_models else None
                )
            if not target_model:
                raise ValueError(f"Service {vlm_service} has no available vision models")

            provider_config = {
                'provider': service_id,
                'model': target_model.get('name', ''),
                'base_url': service.get('base_url', ''),
                'api_key': service.get('api_key', ''),
                'temperature': target_model.get('temperature', 0.7),
                'max_tokens': target_model.get('max_tokens', 1000),
                'top_p': target_model.get('top_p', 0.9),
            }
            if service.get('type') == 'ollama':
                provider_config['auto_unload'] = ollama_auto_unload

            if not provider_config.get('model', ''):
                raise ValueError(f"Please configure model for {vlm_service}")
            if cls._service_requires_api_key(service) and not provider_config.get('api_key', ''):
                raise ValueError(f"Please configure API key and model for {vlm_service}")

            # ------------------------------------------------------------------
            # 3. 分析图像：支持 batch（逐帧独立调用）
            # ------------------------------------------------------------------
            request_id = generate_request_id("vlm", None, unique_id)

            # ------------------------------------------------------------------
            # 3a. 多图模式：image2~image9 任一接入时，所有图像合并进一次 VLM 请求
            # ------------------------------------------------------------------
            extra_images = [
                img for img in (image2, image3, image4, image5, image6, image7, image8, image9)
                if img is not None
            ]
            if extra_images:
                # 展开所有输入的帧（支持每个输入口本身是 batch）
                frames = []
                for tensor in (image, *extra_images):
                    if len(tensor.shape) == 4:
                        for i in range(tensor.shape[0]):
                            frames.append(tensor[i])
                    else:
                        frames.append(tensor)

                # 按模型多图上限截断（服务层还有最后防线）
                from ..utils.common import get_model_max_images
                max_images = get_model_max_images(provider_config.get('model', ''))
                original_count = len(frames)
                if original_count > max_images:
                    frames = frames[:max_images]
                    print(
                        f"{cls.LOG_PREFIX} ⚠️ 多图反推 | 图片数 {original_count} "
                        f"超过模型上限 {max_images}，已截断，忽略 {original_count - max_images} 张"
                    )

                images_data = [cls._image_to_base64(f) for f in frames]

                model_full_name = provider_config.get('model')
                thinking_extra = (
                    build_thinking_suppression(service_id, model_full_name)
                    if service.get('disable_thinking', True) else None
                )
                model_display = format_model_with_thinking(model_full_name, bool(thinking_extra))
                service_display_name = service.get('name', service_id)

                log_prepare(
                    TASK_IMAGE_CAPTION, request_id, SOURCE_NODE,
                    service_display_name, model_display,
                    f"{rule_name} [Multi {len(images_data)} images]"
                )

                result = cls._run_vision_task(
                    VisionService.analyze_images,
                    service_id,
                    images_data=images_data,
                    prompt_content=prompt_to_send,
                    request_id=request_id,
                    custom_provider=service_id,
                    custom_provider_config=provider_config,
                    task_type=TASK_IMAGE_CAPTION,
                    source=SOURCE_NODE
                )

                if result and result.get('success'):
                    data = result.get('data', {})
                    caption_text = data.get('description', data.get('caption', '')).strip()
                    if not caption_text:
                        error_msg = 'API returned empty result'
                        log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
                        raise RuntimeError(f"Analysis failed: {error_msg}")
                    return io.NodeOutput(caption_text, [caption_text])
                else:
                    error_msg = (
                        result.get('error', 'Unknown error') if result
                        else 'No result returned'
                    )
                    if error_msg == "任务被中断":
                        raise InterruptProcessingException()
                    log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
                    raise RuntimeError(f"Analysis failed: {error_msg}")

            # 检查是否为多帧 batch [N, H, W, C] 且 N > 1
            if len(image.shape) == 4 and image.shape[0] > 1:
                # Batch 模式：逐帧独立调用 VLM
                batch_size = image.shape[0]
                results: list[str] = []

                for i in range(batch_size):
                    single_frame = image[i:i + 1]  # 保持 4D 形状 [1, H, W, C]
                    image_data = cls._image_to_base64(single_frame)
                    frame_provider_config = provider_config
                    if service.get('type') == 'ollama':
                        frame_provider_config = provider_config.copy()
                        frame_provider_config['auto_unload'] = bool(ollama_auto_unload) and i == batch_size - 1
                    # 为每帧生成独立的 request_id，便于日志追踪
                    frame_request_id = generate_request_id("vlm", None, f"{unique_id}_f{i}")
                    description = cls._analyze_single_image(
                        image_data=image_data,
                        prompt_to_send=prompt_to_send,
                        rule_name=rule_name,
                        service_id=service_id,
                        service=service,
                        provider_config=frame_provider_config,
                        request_id=frame_request_id,
                        frame_index=i
                    )
                    results.append(description)

                # 合并文本（与旧版保持一致）
                combined_text = "\n---\n".join(results)
                return io.NodeOutput(combined_text, results)

            else:
                # 单张模式
                image_data = cls._image_to_base64(image)
                description = cls._analyze_single_image(
                    image_data=image_data,
                    prompt_to_send=prompt_to_send,
                    rule_name=rule_name,
                    service_id=service_id,
                    service=service,
                    provider_config=provider_config,
                    request_id=request_id,
                    frame_index=None
                )
                # 单张时 caption_list 为单元素列表
                return io.NodeOutput(description, [description])

        except InterruptProcessingException:
            raise
        except Exception as e:
            error_msg = format_api_error(e, vlm_service)
            log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Analysis error: {error_msg}")
