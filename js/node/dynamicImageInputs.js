/**
 * 图像反推节点动态多图输入
 *
 * 功能：ImageCaptionNode 的 image2~image9 输入口默认隐藏，仅在图像（image）
 * 接入后出现 image2，接入 image2 后出现 image3……以此类推，最高支持 9 张图。
 * 断开某个输入时，其后的所有输入口级联回收（链接一并断开）。
 *
 * 实现方式：前端动态增删输入槽（与 Impact Pack 等动态输入插件同套路），
 * 后端 schema 保持 image2~image9 可选输入定义不变，工作流保存/加载通过
 * onConfigure 按名称恢复已连接的槽位。
 */

import { app } from "../../../../scripts/app.js";

const EXTENSION_NAME = "Comfy.PromptAssistant.DynamicImageInputs";
/** 节点后端 schema 中的 node_id */
const TARGET_NODE_ID = "ImageCaptionNode";
/** image 槽位总数（image + image2~image9） */
const MAX_IMAGE_SLOTS = 9;
/** 匹配所有图像输入槽位名：image / image2 ~ image9 */
const IMAGE_NAME_RE = /^(image|image[2-9])$/;

/**
 * 获取节点上所有图像输入槽位（按 node.inputs 中的实际顺序）
 */
function getImageSlots(node) {
    if (!node || !Array.isArray(node.inputs)) return [];
    return node.inputs.filter((s) => IMAGE_NAME_RE.test(s.name || ""));
}

/**
 * 按规则同步节点的图像输入槽位：
 * - 从 image 开始的连续已连接链 + 一个空槽位 = 应显示的槽位集合
 * - 链尾全部连接且未达上限时，追加下一个空槽位
 * - 中途出现未连接的槽位时，其后的槽位级联移除（链接一并断开）
 */
function applyDynamicInputs(node) {
    if (!node || !Array.isArray(node.inputs) || node._dynImgLock) return;
    node._dynImgLock = true;
    try {
        const imgSlots = getImageSlots(node);
        if (imgSlots.length === 0) return;

        // 第一个未连接槽位之后的部分不属于期望集合
        let keep = imgSlots.length;
        for (let i = 0; i < imgSlots.length; i++) {
            if (imgSlots[i].link == null) {
                keep = i + 1;
                break;
            }
        }

        // 链尾已全部连接且未达上限 → 追加一个空槽位
        const lastConnected = imgSlots[imgSlots.length - 1].link != null;
        let target = keep;
        if (lastConnected && imgSlots.length < MAX_IMAGE_SLOTS) {
            target = imgSlots.length + 1;
        }

        // 从尾部移除多余槽位（先断开其链接）
        for (let i = imgSlots.length - 1; i >= target; i--) {
            const name = imgSlots[i].name;
            const idx = node.inputs.findIndex((s) => s.name === name);
            if (idx === -1) continue;
            if (node.inputs[idx].link != null) {
                try {
                    node.disconnectInput(idx);
                } catch (e) {
                    /* 链接可能已被上游移除，忽略 */
                }
            }
            if (typeof node.removeInput === "function") {
                node.removeInput(idx);
            } else {
                node.inputs.splice(idx, 1);
            }
        }

        // 追加下一个空槽位
        if (target > imgSlots.length) {
            const n = imgSlots.length + 1;
            node.addInput(n === 1 ? "image" : `image${n}`, "IMAGE");
        }
    } finally {
        node._dynImgLock = false;
    }
}

/**
 * 工作流加载时按保存的 inputs 信息恢复已连接的槽位（按名称匹配，不依赖槽位索引）
 */
function restoreFromSavedInputs(node, info) {
    if (!info || !Array.isArray(info.inputs)) return;

    // 统计保存数据中已连接的图像槽位数量（按我们的规则它们是连续的）
    let linkedCount = 0;
    for (const saved of info.inputs) {
        if (!saved || !IMAGE_NAME_RE.test(saved.name || "")) continue;
        if (saved.link != null) linkedCount++;
    }

    // 补建缺失的槽位（onNodeCreated 时只保留了 image）
    for (let n = 2; n <= linkedCount; n++) {
        const name = `image${n}`;
        if (!node.inputs.some((s) => s.name === name)) {
            node.addInput(name, "IMAGE");
        }
    }

    // 按名称回填链接 id（litegraph 的 configure 因槽位缺失会跳过这些链接）
    for (const saved of info.inputs) {
        if (!saved || !IMAGE_NAME_RE.test(saved.name || "")) continue;
        if (saved.link == null) continue;
        const slot = node.inputs.find((s) => s.name === saved.name);
        if (slot) slot.link = saved.link;
    }
}

app.registerExtension({
    name: EXTENSION_NAME,

    beforeRegisterNodeDef(nodeType, nodeData) {
        // 只处理图像反推节点
        if (!nodeData || nodeData.name !== TARGET_NODE_ID) return;

        const proto = nodeType.prototype;

        // 创建时：移除 image2~image9，只保留 image
        const origOnNodeCreated = proto.onNodeCreated;
        proto.onNodeCreated = function () {
            const r = origOnNodeCreated ? origOnNodeCreated.apply(this, arguments) : undefined;
            if (Array.isArray(this.inputs)) {
                for (let i = this.inputs.length - 1; i >= 0; i--) {
                    if (/^image[2-9]$/.test(this.inputs[i].name || "")) {
                        if (typeof this.removeInput === "function") {
                            this.removeInput(i);
                        } else {
                            this.inputs.splice(i, 1);
                        }
                    }
                }
            }
            return r;
        };

        // 加载工作流：按保存的数据恢复槽位和链接，然后同步一次
        const origOnConfigure = proto.onConfigure;
        proto.onConfigure = function (info) {
            const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
            try {
                restoreFromSavedInputs(this, info);
                applyDynamicInputs(this);
            } catch (e) {
                console.warn("[PromptAssistant] 动态图像输入恢复失败：", e);
            }
            return r;
        };

        // 连接/断开：重新同步槽位
        const origOnConnectionsChange = proto.onConnectionsChange;
        proto.onConnectionsChange = function () {
            const r = origOnConnectionsChange
                ? origOnConnectionsChange.apply(this, arguments)
                : undefined;
            try {
                applyDynamicInputs(this);
            } catch (e) {
                console.warn("[PromptAssistant] 动态图像输入同步失败：", e);
            }
            return r;
        };
    },
});

console.log("[PromptAssistant] 动态图像输入扩展已加载（最多 9 图）");
