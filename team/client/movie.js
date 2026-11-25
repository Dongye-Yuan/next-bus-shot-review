export function moviePlan(clips, versions, selected) {
  const byId = new Map(versions.map((version) => [version.id, version]));
  let duration = 0;
  const shots = clips.map((clip, index) => {
    const version = byId.get(selected[clip.id]);
    const shot = {
      ...clip, index, start: duration,
      version: version?.shot === clip.id && version.status === "approved" ? version : null,
    };
    duration += clip.duration;
    return shot;
  });
  return { shots, duration, missing: shots.filter(({ version }) => !version) };
}

const width = 720;
const height = 1280;
const fps = 30;
const demoMedia = "https://next-bus-shot-review.riferice4.chatgpt.site/media/";
const demoExportMedia = "https://raw.githubusercontent.com/Dongye-Yuan/next-bus-shot-review/5034e17b5910d7cd439b71c9a8f14a48dec2461c/dist/media/";

function waitForMedia(node, event, start, signal) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer);
      node.removeEventListener(event, loaded);
      node.removeEventListener("error", failed);
      signal.removeEventListener("abort", canceled);
      if (error) reject(error);
      else resolve();
    }
    const loaded = () => finish();
    const failed = () => finish(new Error("素材无法读取。"));
    const canceled = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("素材加载超时。")), 30000);
    node.addEventListener(event, loaded);
    node.addEventListener("error", failed);
    signal.addEventListener("abort", canceled, { once: true });
    if (signal.aborted) canceled();
    else start();
  });
}

function loadShot(shot, signal) {
  const video = shot.version.type === "video";
  const node = document.createElement(video ? "video" : "img");
  if (video) {
    node.playsInline = true;
    node.preload = "auto";
  }
  const source = shot.version.file;
  let url = source;
  if (source.startsWith(demoMedia)) {
    // The published demo serves the same files without cross-origin canvas access.
    node.crossOrigin = "anonymous";
    url = demoExportMedia + encodeURIComponent(source.slice(demoMedia.length));
  }
  return {
    node, video, shot,
    ready: waitForMedia(node, video ? "loadeddata" : "load", () => { node.src = url; }, signal)
      .catch((error) => {
        signal.throwIfAborted();
        throw new Error("镜头 " + (shot.index + 1) + "「" + shot.title + "」" + error.message);
      }),
  };
}

function draw(context, { node, video }) {
  const w = video ? node.videoWidth : node.naturalWidth;
  const h = video ? node.videoHeight : node.naturalHeight;
  const scale = Math.min(width / w, height / h);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.drawImage(node, (width - w * scale) / 2, (height - h * scale) / 2, w * scale, h * scale);
}

function recordStream(stream, hasVideo, signal) {
  const preferred = hasVideo
    ? ['video/mp4;codecs="avc1.42001f,mp4a.40.2"', 'video/mp4;codecs="avc1,mp4a.40.2"']
    : ['video/mp4;codecs="avc1.42001f"', 'video/mp4;codecs="avc1"'];
  const mimeType = [...preferred, "video/mp4"].find((mime) => MediaRecorder.isTypeSupported(mime));
  if (!mimeType) throw new Error("当前浏览器无法生成 MP4。请在支持 MP4 录制的桌面浏览器中打开工作区。");
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    recorder.onerror = (event) => reject(event.error ?? new Error("视频编码失败。"));
    recorder.onstop = () => {
      const file = new Blob(chunks, { type: "video/mp4" });
      if (signal.aborted) reject(signal.reason);
      else if (!file.size) reject(new Error("未生成视频数据。"));
      else resolve(file);
    };
  });
  // Encoding can fail before the render loop finishes.
  result.catch(() => {});
  return { recorder, result };
}

function drawTimeline(context, loaded, plan, onProgress, signal) {
  return new Promise((resolve, reject) => {
    let frame;
    let current;
    const start = performance.now();
    function finish(error) {
      cancelAnimationFrame(frame);
      signal.removeEventListener("abort", cancel);
      if (current?.video) current.node.pause();
      if (error) reject(error);
      else resolve();
    }
    const cancel = () => finish(signal.reason);
    function tick(now) {
      try {
        signal.throwIfAborted();
        const elapsed = Math.max(0, (now - start) / 1000);
        if (elapsed >= plan.duration) return finish();
        const shot = loaded.findLast(({ shot }) => elapsed >= shot.start);
        if (current !== shot) {
          if (current?.video) current.node.pause();
          current = shot;
          if (shot.video) {
            shot.node.play().catch(() => finish(new Error("镜头「" + shot.shot.title + "」无法播放。")));
          }
        }
        if (shot.video && shot.node.error) throw new Error("镜头「" + shot.shot.title + "」读取中断。");
        const expected = shot.video && Math.min(elapsed - shot.shot.start, shot.node.duration);
        if (shot.video && expected - shot.node.currentTime > 0.75) {
          throw new Error("镜头「" + shot.shot.title + "」缓冲中断，请重试导出。");
        }
        draw(context, shot);
        onProgress(elapsed);
        frame = requestAnimationFrame(tick);
      } catch (error) {
        finish(error);
      }
    }
    signal.addEventListener("abort", cancel, { once: true });
    tick(start);
  });
}

export async function renderMovie(plan, onProgress, controller) {
  const { signal } = controller;
  const canvas = document.createElement("canvas");
  if (!window.MediaRecorder || !canvas.captureStream) {
    throw new Error("当前浏览器无法生成 MP4。请在支持 MP4 录制的桌面浏览器中打开工作区。");
  }
  const hasVideo = plan.shots.some(({ version }) => version.type === "video");
  const context = canvas.getContext("2d");
  canvas.width = width;
  canvas.height = height;
  // Keep the canvas active on browsers that suspend unmounted capture.
  canvas.className = "movie-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.querySelector("#movie-dialog").append(canvas);
  const loaded = [];
  let audio;
  let stream;
  let recorder;
  const hide = () => {
    if (document.hidden) controller.abort(new Error("导出时请保持此页面在前台，再重试。"));
  };
  document.addEventListener("visibilitychange", hide);
  try {
    if (hasVideo) {
      audio = new AudioContext();
      await audio.resume();
      signal.throwIfAborted();
    }
    const destination = audio?.createMediaStreamDestination();
    for (const shot of plan.shots) {
      signal.throwIfAborted();
      const item = loadShot(shot, signal);
      loaded.push(item);
      await item.ready;
      if (item.video) audio.createMediaElementSource(item.node).connect(destination);
    }
    draw(context, loaded[0]);
    stream = canvas.captureStream(fps);
    if (destination) stream.addTrack(destination.stream.getAudioTracks()[0]);
    const recording = recordStream(stream, hasVideo, signal);
    recorder = recording.recorder;
    recorder.addEventListener("error", (event) => controller.abort(event.error ?? new Error("视频编码失败。")));
    recorder.start(1000);
    await drawTimeline(context, loaded, plan, onProgress, signal);
    recorder.stop();
    return await recording.result;
  } finally {
    document.removeEventListener("visibilitychange", hide);
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    for (const { node, video } of loaded) {
      if (video) node.pause();
      node.removeAttribute("src");
      if (video) node.load();
    }
    if (audio) await audio.close();
    canvas.remove();
  }
}
