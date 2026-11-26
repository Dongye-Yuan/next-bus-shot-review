export const angles = { front: "正面", side: "侧面", full: "全身" };

export function shotPrompt({ shot, type, references, scene, frame, from, directive }) {
  const video = type === "video";
  if (video && (frame?.type !== "image" || frame.status !== "approved" || frame.shot !== shot.id)) {
    throw new Error("先为当前镜头确认关键帧，再复制视频提示词。");
  }
  const editImage = !video && from && (from.type === "image" ? from : frame);
  const assets = [];
  if (video) assets.push({ file: frame.file, label: "图 1 · 已确认首帧 · " + frame.title });
  else if (editImage) assets.push({ file: editImage.file, label: "图 1 · 待修正的原图 · " + editImage.title });

  const identities = references.map(({ ref, angle }) => {
    const view = angles[angle];
    const image = ref.images[angle];
    if (image?.file) assets.push({
      file: image.file, label: "图 " + (assets.length + 1) + " · " + ref.name + " · 第 " + ref.edition + " 版 · " + view,
      optional: video,
    });
    return ref.name + "（第 " + ref.edition + " 版，" + view + "参考）"
      + "\n身份特征：" + ref.identity + "\n服装设定：" + ref.outfit;
  });

  if (scene?.image?.file) assets.push({
    file: scene.image.file, label: "图 " + (assets.length + 1) + " · 场景参考 · " + scene.name + " · 第 " + scene.edition + " 版",
    optional: video,
  });

  const note = from?.note?.trim();
  const custom = directive?.trim();
  const context = shot.context?.trim();
  const issues = (from?.issues ?? []).map((issue) => {
    const time = from.type === "video" && Number.isFinite(issue.time) ? issue.time + " 秒：" : "";
    return time + issue.feature + " · " + issue.note;
  });
  const direction = video
    ? [
      "生成一条 9:16 竖屏视频，目标 " + shot.duration + " 秒。用图 1 作为第一帧。按分镜的机位、景别和动作推进，保持一个连续镜头。",
      "保持首帧中的人物站位、背景、服装和光线。只有分镜明确要求时才移动镜头，否则固定机位。动作须在目标时长内完成，工具若输出更长，余下时间保持最终构图。",
    ].join("\n")
    : (editImage ? "编辑图 1，保持原图构图和场景，按返工要求修正。"
      : "生成一张 9:16 竖屏漫剧关键帧，呈现这个镜头的起始状态。");
  const layers = [
    direction,
    "镜头：" + shot.title + (context ? "\n分镜要求：\n" + context : ""),
    identities.length ? "角色一致性：\n" + identities.join("\n\n")
      + "\n左右均以角色本人为准。被遮挡的一侧不应凭空出现发夹、疤痕等标志性细节。" : "",
    scene ? "场景一致性：\n" + scene.name + "（第 " + scene.edition + " 版）\n" + scene.description : "",
    assets.length ? "素材顺序：\n" + assets.map(({ label, optional }) => label +
      (optional ? "（工具支持额外参考图时附加；单首帧模式只上传图 1）" : "")).join("\n") : "",
    note ? "返工要求（优先修复）：\n" + note : "",
    issues.length ? "原版问题定位：\n" + issues.join("\n") : "",
    custom && custom !== note && custom !== context ? "补充要求：\n" + custom : "",
  ];
  return { text: layers.filter(Boolean).join("\n\n"), assets };
}
