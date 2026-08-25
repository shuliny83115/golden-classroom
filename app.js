const cfg = window.GOLDEN_CLASSROOM_CONFIG;
const supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const loginView = document.querySelector("#loginView");
const classroomView = document.querySelector("#classroomView");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const userBadge = document.querySelector("#userBadge");
const roomNameEl = document.querySelector("#roomName");
const roomStatus = document.querySelector("#roomStatus");
const modePill = document.querySelector("#modePill");
const controlWrap = document.querySelector("#controlWrap");
const controlBtn = document.querySelector("#controlBtn");
const controlMenu = document.querySelector("#controlMenu");
const controlLabel = document.querySelector("#controlLabel");
const studentHint = document.querySelector("#studentHint");
const toast = document.querySelector("#toast");
const vmScreen = document.querySelector(".vm-screen");
const vmZoomOut = document.querySelector("#vmZoomOut");
const vmZoomIn = document.querySelector("#vmZoomIn");
const vmZoomLabel = document.querySelector("#vmZoomLabel");
const vmFitBtn = document.querySelector("#vmFitBtn");
const teacherVideo = document.querySelector("#teacherVideo");
const studentVideo = document.querySelector("#studentVideo");
const micBtn = document.querySelector("#micBtn");
const cameraBtn = document.querySelector("#cameraBtn");
const teacherCameraOff = document.querySelector("#teacherCameraOff");
const studentCameraOff = document.querySelector("#studentCameraOff");

let profile = null;
let room = null;
let roomState = null;
let vmZoom = Number(localStorage.getItem("goldenClassroomVmZoom")) || 100;
let localMediaStream = null;
let mediaPeer = null;
let mediaSignalChannel = null;
let mediaPeerId = null;
let mediaCallStarting = false;
let pendingMediaIce = [];
let micEnabled = true;
let cameraEnabled = true;
let mediaReconnectTimer = null;
let mediaReconnectAttempts = 0;
let mediaReconnectInProgress = false;
let mediaSignalReady = false;
let mediaSignalHadError = false;
let classroomRecoveryInProgress = false;
let viewerSignalHadError = false;
let networkRecoveryInProgress = false;

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeSupabaseRealtime(timeoutMs = 2500) {
  const probeChannel = supabaseClient.channel(
    `recovery-probe-${Date.now()}-${Math.random()}`
  );

  return new Promise((resolve) => {
    let finished = false;

    const finish = async (ok) => {
      if (finished) return;
      finished = true;

      clearTimeout(timeout);

      try {
        await supabaseClient.removeChannel(probeChannel);
      } catch (_) {}

      resolve(ok);
    };

    const timeout = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    probeChannel.subscribe((status) => {
      console.log(
        "RECOVERY REALTIME PROBE:",
        status
      );

      if (status === "SUBSCRIBED") {
        finish(true);
        return;
      }

      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        finish(false);
      }
    });
  });
}
async function waitForSupabaseOnline(
  timeoutMs = 10000,
  intervalMs = 400
) {
  const start = Date.now();
  let realtimeResetDone = false;

  while (Date.now() - start < timeoutMs) {
    try {
      // 第一關：確認 REST API 已經真的恢復
      const { error } = await supabaseClient
        .from("room_agents")
        .select("user_id")
        .limit(1);

      if (!error) {
        console.log(
          "SUPABASE REST READY - checking Realtime..."
        );

        // 換網路後，不再等舊 WebSocket 自己復活
        // 主動重建 Supabase Realtime socket，一次就好
        if (!realtimeResetDone) {
          realtimeResetDone = true;

          console.warn(
            "RESETTING SUPABASE REALTIME CONNECTION"
          );

          try {
            supabaseClient.realtime.disconnect();
          } catch (_) {}

          await waitMs(150);

          try {
            supabaseClient.realtime.connect();
          } catch (_) {}

          // 給新的 WebSocket 一點建立時間
          await waitMs(300);
        }

        // 第二關：實際確認新的 Realtime 可以 SUBSCRIBED
        const realtimeReady =
          await probeSupabaseRealtime();

        if (realtimeReady) {
          console.log(
            "SUPABASE FULLY READY"
          );

          return true;
        }
      }

    } catch (_) {}

    await waitMs(intervalMs);
  }

  throw new Error(
    "SUPABASE FULL RECOVERY TIMEOUT"
  );
}
  
async function recoverClassroomConnections(reason = "unknown") {
  if (classroomRecoveryInProgress) {
    console.log("CLASSROOM RECOVERY SKIPPED - already running:", reason);
    return;
  }

  classroomRecoveryInProgress = true;
  console.warn("CLASSROOM RECOVERY START:", reason);

  try {
    // 1. 先恢復 Room Agent 桌面串流 + Control DataChannel
    console.log("RECOVERY: rebuilding Room1 viewer...");
await startWebRtcViewer(true);

    console.log("RECOVERY: rebuilding media signaling...");
await subscribeMediaSignals();

    // 2. 再恢復老師 / 學生攝影機與麥克風 WebRTC
    console.log("RECOVERY: rebuilding media connection...");

    if (profile?.role === "teacher") {
      await startTeacherMediaCall(true);
    } else if (profile?.role === "student") {
      await sendMediaSignal("ready", {});
    }

    console.log("CLASSROOM RECOVERY COMPLETE:", reason);

  } catch (err) {
    console.error("CLASSROOM RECOVERY ERROR:", reason, err);

  } finally {
    classroomRecoveryInProgress = false;
  }
}
window.addEventListener("online", async () => {
  console.warn("NETWORK ONLINE");

  if (!profile || !room) return;

  // 同一次 Wi-Fi 切換只允許一個網路恢復流程
  if (networkRecoveryInProgress) {
    console.log(
      "NETWORK RECOVERY SKIPPED - already running"
    );
    return;
  }

  networkRecoveryInProgress = true;

  try {
    console.log(
      "WAITING FOR SUPABASE FULL RECOVERY..."
    );

    await waitForSupabaseOnline();

    console.log(
      "NETWORK + REALTIME READY - starting recovery"
    );

    await recoverClassroomConnections(
      "network_fully_online"
    );

  } catch (err) {
    console.error(
      "NETWORK RECOVERY WAIT FAILED:",
      err
    );

  } finally {
    networkRecoveryInProgress = false;
  }
});

const MEDIA_RECONNECT_DELAY = 3000;
const MEDIA_MAX_RECONNECT_ATTEMPTS = 5;

function updateCameraOffOverlay(role, isOff) {
  const overlay =
    role === "teacher"
      ? teacherCameraOff
      : studentCameraOff;

  if (!overlay) return;

  overlay.classList.toggle("hidden", !isOff);
}

async function startTeacherMediaCall(force = false) {
  if (profile?.role !== "teacher") return;

  // 已經正在建立 Offer 時，永遠不要重複建立
  if (mediaCallStarting) {
    return;
  }

  // 一般情況下，已有正常連線就不重建
  // force=true 時則強制換掉舊 PeerConnection
  if (
    !force &&
    (
      mediaPeer?.connectionState === "connecting" ||
      mediaPeer?.connectionState === "connected"
    )
  ) {
    return;
  }

  mediaCallStarting = true;

  try {
    await createMediaPeer();

    const offer = await mediaPeer.createOffer();

    await mediaPeer.setLocalDescription(offer);

    await sendMediaSignal("offer", {
      description: mediaPeer.localDescription
    });

    console.log(
      force
        ? "MEDIA OFFER SENT (FORCED RECONNECT)"
        : "MEDIA OFFER SENT"
    );
  } finally {
    mediaCallStarting = false;
  }
}
async function flushPendingMediaIce() {
  if (!mediaPeer?.remoteDescription) return;

  while (pendingMediaIce.length > 0) {
    const candidate = pendingMediaIce.shift();

    try {
      await mediaPeer.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (err) {
      console.error("PENDING MEDIA ICE ERROR:", err);
    }
  }
}

async function handleMediaSignal(signal) {
  const type = signal.signal_type;
  const data = signal.payload;
  console.log("MEDIA SIGNAL RECEIVED:", type, data, signal.sender_role);
    // 老師 / 學生互相確認已進入影音 signaling
  if (type === "ready") {
    console.log(
      "MEDIA READY FROM:",
      signal.sender_role
    );

    // 老師收到學生 ready → 正式發起 WebRTC
    if (
  profile?.role === "teacher" &&
  signal.sender_role === "student"
) {
  // 學生送出 ready 代表可能是新頁面 / 重新登入，
  // 不相信舊 PeerConnection 的 connected 狀態，直接重建。
  await startTeacherMediaCall(true);
}

    // 如果學生先登入、老師後登入：
    // 學生收到老師 ready 時再回報一次自己的 ready
    if (
      profile?.role === "student" &&
      signal.sender_role === "teacher"
    ) {
      await sendMediaSignal("ready", {});
    }

    return;
  }

  if (type === "offer") {
    // 只有學生處理老師的 offer
    if (profile?.role !== "student") return;

    await createMediaPeer();

    await mediaPeer.setRemoteDescription(
      new RTCSessionDescription(data.description)
    );
    await flushPendingMediaIce();

    const answer = await mediaPeer.createAnswer();

    await mediaPeer.setLocalDescription(answer);

    await sendMediaSignal("answer", {
      description: mediaPeer.localDescription
    });

    console.log("MEDIA ANSWER SENT");
    return;
  }

  if (type === "answer") {
    // 只有老師處理學生的 answer
    if (profile?.role !== "teacher") return;
    if (!mediaPeer) return;

    await mediaPeer.setRemoteDescription(
  new RTCSessionDescription(data.description)
);

await flushPendingMediaIce();

console.log("MEDIA ANSWER RECEIVED");
    return;
  }
  if (type === "camera_state") {
  const enabled = data?.enabled === true;

  // 目前為一對一教室：
  // 老師收到的遠端一定是學生
  // 學生收到的遠端一定是老師
  const remoteRole =
    profile?.role === "teacher"
      ? "student"
      : "teacher";

  console.log(
    "REMOTE CAMERA STATE:",
    remoteRole,
    enabled
  );

  updateCameraOffOverlay(
    remoteRole,
    !enabled
  );

  return;
}
  if (type === "ice") {
  if (!data?.candidate) return;

  // Peer 尚未建立，或對方 SDP 尚未設定完成
  // 先保存 ICE，不要丟掉
  if (!mediaPeer || !mediaPeer.remoteDescription) {
    pendingMediaIce.push(data.candidate);
    console.log("MEDIA ICE QUEUED");
    return;
  }
  try {
    await mediaPeer.addIceCandidate(
      new RTCIceCandidate(data.candidate)
    );

    console.log("MEDIA ICE ADDED");
  } catch (err) {
    console.error("MEDIA ICE ERROR:", err);
  }

  return;
}
}
function scheduleMediaReconnect(reason = "unknown") {
  if (mediaReconnectInProgress) return;
  if (mediaReconnectTimer) return;

  if (mediaReconnectAttempts >= MEDIA_MAX_RECONNECT_ATTEMPTS) {
    console.error(
      "MEDIA RECONNECT STOPPED: max attempts reached",
      reason
    );
    return;
  }

  console.log(
    "MEDIA RECONNECT SCHEDULED:",
    reason,
    `attempt ${mediaReconnectAttempts + 1}`
  );

  mediaReconnectTimer = setTimeout(async () => {
  mediaReconnectTimer = null;

  // Signaling 還沒恢復，不要急著重連
  if (!mediaSignalReady) {
    console.log(
      "MEDIA RECONNECT WAITING FOR SIGNAL CHANNEL"
    );

    scheduleMediaReconnect("waiting_for_signal");
    return;
  }

  mediaReconnectInProgress = true;
  mediaReconnectAttempts += 1;

  try {
    console.log(
      "MEDIA RECONNECT START:",
      mediaReconnectAttempts
    );

    // 老師負責主動重建連線
    if (profile?.role === "teacher") {
      await startTeacherMediaCall(true);
      return;
    }

    // 學生只通知老師自己還在線
    if (profile?.role === "student") {
      await sendMediaSignal("ready", {});
      return;
    }

  } catch (err) {
    console.error(
      "MEDIA RECONNECT ERROR:",
      err
    );
  } finally {
    mediaReconnectInProgress = false;
  }
}, MEDIA_RECONNECT_DELAY);
}
function resetMediaReconnectState() {
  if (mediaReconnectTimer) {
    clearTimeout(mediaReconnectTimer);
    mediaReconnectTimer = null;
  }

  mediaReconnectAttempts = 0;
  mediaReconnectInProgress = false;
}
async function createMediaPeer() {
  if (mediaPeer) {
    mediaPeer.close();
    mediaPeer = null;
  }

  if (!RTC_CONFIG) {
  await loadRtcConfig();
}

mediaPeer = new RTCPeerConnection(RTC_CONFIG);

  // 把自己的攝影機 + 麥克風加入連線
  if (localMediaStream) {
    localMediaStream.getTracks().forEach((track) => {
      mediaPeer.addTrack(track, localMediaStream);
    });
  }

  // 收到對方的影音
  mediaPeer.ontrack = (event) => {
    const remoteVideo = getRemoteMediaVideo();

    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.muted = false;
      remoteVideo.play().catch(() => {});
    }

    console.log("REMOTE MEDIA RECEIVED");
  };

  // ICE candidate 傳給另一端
  mediaPeer.onicecandidate = (event) => {
    if (!event.candidate) return;

    sendMediaSignal("ice", {
      candidate: event.candidate
    });
  };

  mediaPeer.onconnectionstatechange = () => {
  const state = mediaPeer?.connectionState;

  console.log(
    "MEDIA CONNECTION STATE:",
    state
  );

  if (state === "connected") {
    console.log("MEDIA CONNECTION HEALTHY");
    resetMediaReconnectState();
    return;
  }

  if (state === "disconnected") {
    console.warn(
      "MEDIA CONNECTION DISCONNECTED"
    );
    return;
  }

  if (state === "failed") {
    console.error(
      "MEDIA CONNECTION FAILED"
    );
    return;
  }

  if (state === "closed") {
    console.log(
      "MEDIA CONNECTION CLOSED"
    );
  }
};


  return mediaPeer;
}
async function sendMediaSignal(type, payload) {
  if (!mediaSignalChannel) {
    console.log("MEDIA SIGNAL NOT SENT - no channel:", type);
    return;
  }

  const result = await mediaSignalChannel.send({
    type: "broadcast",
    event: "media-signal",
    payload: {
      room_id: room.id,
      sender_id: profile.id,
      sender_role: profile.role,
      signal_type: type,
      payload
    }
  });

  console.log(
    "MEDIA SIGNAL SENT:",
    type,
    payload,
    result
  );
}
async function subscribeMediaSignals() {
  if (!room?.id || !profile?.id) return;

  if (mediaSignalChannel) {
    await supabaseClient.removeChannel(mediaSignalChannel);
    mediaSignalChannel = null;
  }

  mediaSignalChannel = supabaseClient
    .channel(`media-signals-${room.id}`)
    .on(
      "broadcast",
      { event: "media-signal" },
      async ({ payload }) => {
        if (!payload) return;

        // 自己送出的訊號不要自己處理
        if (payload.sender_id === profile.id) return;

        // 只接受同一個 Room
        if (payload.room_id !== room.id) return;

        await handleMediaSignal(payload);
      }
    );

  // 等到 Supabase Realtime 真正 SUBSCRIBED 才繼續
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("MEDIA SIGNAL CHANNEL 訂閱逾時")
      );
    }, 10000);

    mediaSignalChannel.subscribe((status) => {
      console.log(
        "MEDIA SIGNAL CHANNEL:",
        status
      );

      if (status === "SUBSCRIBED") {
        const wasRecovered =
          mediaSignalHadError;

        mediaSignalReady = true;
        mediaSignalHadError = false;

        clearTimeout(timeout);
        resolve();

        // 網路曾經斷線，現在 signaling 已恢復
        if (wasRecovered) {
  console.log("MEDIA SIGNAL RESTORED");

  recoverClassroomConnections(
    "media_signal_restored"
  );
}

        return;
      }

      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        mediaSignalReady = false;
        mediaSignalHadError = true;

        console.warn(
          "MEDIA SIGNAL LOST:",
          status
        );

        // 初次登入時如果訂閱真的失敗，
        // 讓 Promise 能結束，不要永遠卡住
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT"
        ) {
          clearTimeout(timeout);
          reject(
            new Error(
              `MEDIA SIGNAL CHANNEL: ${status}`
            )
          );
        }

        return;
      }
    });
  });

  console.log("MEDIA SIGNAL READY");
}
function getRemoteMediaVideo() {
  if (profile?.role === "teacher") {
    return studentVideo;
  }

  return teacherVideo;
}
async function startLocalMedia() {
  try {
    localMediaStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    setMicEnabled(micEnabled);
    setCameraEnabled(cameraEnabled);

    if (profile?.role === "teacher") {
      teacherVideo.srcObject = localMediaStream;
      teacherVideo.muted = true;
    } else if (profile?.role === "student") {
      studentVideo.srcObject = localMediaStream;
      studentVideo.muted = true;
    }

    console.log("LOCAL CAMERA/MIC READY");
  } catch (err) {
    console.error("LOCAL MEDIA ERROR:", err);
    showToast(`無法啟用攝影機／麥克風：${err.message}`);
  }
}
function updateMediaButtons() {
  micBtn.textContent = micEnabled
    ? "🎤 麥克風"
    : "🔇 麥克風已關閉";

  cameraBtn.textContent = cameraEnabled
    ? "📷 攝影機"
    : "🚫 攝影機已關閉";
}

function setMicEnabled(enabled) {
  micEnabled = enabled;

  if (localMediaStream) {
    localMediaStream.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  updateMediaButtons();
}

function setCameraEnabled(enabled) {
  cameraEnabled = enabled;

  const videoTrack =
    localMediaStream?.getVideoTracks()?.[0];

  if (videoTrack) {
    videoTrack.enabled = enabled;
  }

  // 重新開鏡頭時，重新把目前 video track 掛回 sender
  if (enabled && mediaPeer && videoTrack) {
    const sender = mediaPeer
      .getSenders()
      .find((s) => s.track?.kind === "video");

    if (sender) {
      sender.replaceTrack(videoTrack)
        .catch((err) => {
          console.error(
            "VIDEO TRACK RESTORE FAILED:",
            err
          );
        });
    }
  }

  if (profile?.role) {
    updateCameraOffOverlay(profile.role, !enabled);
  }

  sendMediaSignal("camera_state", {
    enabled
  });

  updateMediaButtons();
}
micBtn.addEventListener("click", () => {
  setMicEnabled(!micEnabled);
});

cameraBtn.addEventListener("click", () => {
  setCameraEnabled(!cameraEnabled);
});
function applyVmZoom() {
  vmZoom = Math.max(40, Math.min(150, vmZoom));

  const scale = vmZoom / 100;

  vmZoomLabel.textContent = `${vmZoom}%`;

  vmScreen.style.width = `${scale * 100}%`;

  // Room1 是 16:9 畫面，寬度改變時高度一起等比例改變
  vmScreen.style.aspectRatio = "16 / 9";
  vmScreen.style.height = "auto";

  localStorage.setItem(
    "goldenClassroomVmZoom",
    String(vmZoom)
  );
}

vmZoomOut.addEventListener("click", () => {
  vmZoom -= 10;
  applyVmZoom();
});

vmZoomIn.addEventListener("click", () => {
  vmZoom += 10;
  applyVmZoom();
});
vmFitBtn.addEventListener("click", () => {
  const panel = vmScreen.closest(".vm-panel");
  if (!panel) return;

  const panelRect = panel.getBoundingClientRect();

  // 多預留一點上方標題列、下方工具列與安全空間
  const availableHeight = window.innerHeight - panelRect.top - 140;
  const availableWidth = panelRect.width;

  // Room1 以 16:9 計算
  const widthBasedScale = availableWidth / 1280;
  const heightBasedScale = availableHeight / 720;

  const fitScale = Math.min(widthBasedScale, heightBasedScale);

  // 轉成百分比後，往下取到最接近的 10%
  vmZoom = Math.floor((fitScale * 100) / 10) * 10;

  // 限制範圍
  vmZoom = Math.max(40, Math.min(150, vmZoom));

  applyVmZoom();
});
applyVmZoom();
let roomStateChannel = null;
let agentStatusTimer = null;
let toastTimer = null;

let controlPingTimer = null;
let controlPingId = 0;
const controlPingTimes = new Map();
let controlWatchdogTriggered = false;
const CONTROL_PONG_TIMEOUT = 5000;
let lastControlPongAt = performance.now();

// WebRTC 遠端控制
let rtcControlChannel = null;
let rtcMouseChannel = null;
let lastMouseSend = 0;
function canRemoteControl() {
  if (!profile || !roomState) return false;

  if (roomState.control_mode === "shared") {
    return (
      profile.role === "teacher" ||
      profile.role === "student"
    );
  }

  if (roomState.control_mode === "teacher") {
    return profile.role === "teacher";
  }

  if (roomState.control_mode === "student") {
    return profile.role === "student";
  }

  return false;
}

function sendControlMessage(message) {
  if (
    !rtcControlChannel ||
    rtcControlChannel.readyState !== "open" ||
    !canRemoteControl()
  ) {
    return;
  }

  rtcControlChannel.send(JSON.stringify(message));
}

let rtcPeer = null;
let rtcSignalChannel = null;
let rtcPeerId = null;
let rtcAgentUserId = null;
let rtcUserId = null;
let rtcVideo = null;
let pendingRemoteIce = [];

const modeText = {
  teacher: "老師控制",
  student: "學生控制",
  shared: "雙人控制"
};

let RTC_CONFIG = null;

async function loadRtcConfig() {
  const { data, error } = await supabaseClient.functions.invoke(
    "turn-credentials"
  );

  if (error) {
    throw new Error(`取得 TURN credentials 失敗：${error.message}`);
  }

  let turnServers = data?.iceServers;

  if (!Array.isArray(turnServers)) {
    turnServers = [turnServers];
  }

  RTC_CONFIG = {
    iceServers: [
      {
        urls: "stun:stun.cloudflare.com:3478"
      },
      ...turnServers
    ],
    iceCandidatePoolSize: 4
  };

  console.log("TURN READY", RTC_CONFIG);
  return RTC_CONFIG;
}

function accountToEmail(value) {
  const v = value.trim();
  return v.includes("@") ? v : `${v}@goldenclassroom.test`;
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 1800);
}

function ensureVmVideo() {
  if (rtcVideo) return rtcVideo;

  vmScreen.innerHTML = "";
  vmScreen.style.position = "relative";

  rtcVideo = document.createElement("video");
  rtcVideo.id = "roomStream";
  rtcVideo.autoplay = true;
  rtcVideo.playsInline = true;
  rtcVideo.muted = true;
  rtcVideo.style.width = "100%";
  rtcVideo.style.height = "100%";
  rtcVideo.style.objectFit = "contain";
  rtcVideo.style.background = "#111827";
  rtcVideo.style.cursor = "none";
  rtcVideo.tabIndex = 0;

  vmScreen.appendChild(rtcVideo);

  // 防止右鍵叫出瀏覽器選單
  rtcVideo.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
rtcVideo.addEventListener("keydown", (event) => {
  if (!canRemoteControl()) return;

  event.preventDefault();

  sendControlMessage({
    type: "key_down",
    key: event.key,
    code: event.code
  });
});

rtcVideo.addEventListener("keyup", (event) => {
  if (!canRemoteControl()) return;

  event.preventDefault();

  sendControlMessage({
    type: "key_up",
    key: event.key,
    code: event.code
  });
});
// 遠端畫面失去焦點時，釋放所有按鍵
rtcVideo.addEventListener("blur", () => {
  sendControlMessage({
    type: "release_all_keys"
  });
});
  // 左鍵 / 右鍵按下
  rtcVideo.addEventListener("mousedown", (event) => {
    rtcVideo.focus();
    event.preventDefault();

    sendControlMessage({
      type: "mouse_down",
      button:
        event.button === 2
          ? "right"
          : event.button === 1
          ? "middle"
          : "left"
    });
  });

  // 左鍵 / 右鍵放開
  rtcVideo.addEventListener("mouseup", (event) => {
    event.preventDefault();

    sendControlMessage({
      type: "mouse_up",
      button:
        event.button === 2
          ? "right"
          : event.button === 1
          ? "middle"
          : "left"
    });
  });

  // 滾輪
  rtcVideo.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      sendControlMessage({
        type: "mouse_scroll",
        deltaY: event.deltaY
      });
    },
    { passive: false }
  );

  // 滑鼠移動
  rtcVideo.addEventListener("mousemove", (event) => {
    const rect = rtcVideo.getBoundingClientRect();

    if (
      !rtcControlChannel ||
      rtcControlChannel.readyState !== "open"
    ) {
      return;
    }

    if (!canRemoteControl()) return;

    // 如果上一筆還在排隊，就丟掉舊座標
    if (rtcControlChannel.bufferedAmount > 0) {
      return;
    }

    const now = performance.now();
    if (now - lastMouseSend < 8) return;
    lastMouseSend = now;

    const videoRatio =
      rtcVideo.videoWidth && rtcVideo.videoHeight
        ? rtcVideo.videoWidth / rtcVideo.videoHeight
        : rect.width / rect.height;

    const boxRatio = rect.width / rect.height;

    let drawWidth;
    let drawHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (videoRatio > boxRatio) {
      drawWidth = rect.width;
      drawHeight = rect.width / videoRatio;
      offsetY = (rect.height - drawHeight) / 2;
    } else {
      drawHeight = rect.height;
      drawWidth = rect.height * videoRatio;
      offsetX = (rect.width - drawWidth) / 2;
    }

    const px = event.clientX - rect.left - offsetX;
    const py = event.clientY - rect.top - offsetY;

    if (
      px < 0 ||
      py < 0 ||
      px > drawWidth ||
      py > drawHeight
    ) {
      return;
    }

    const x = px / drawWidth;
    const y = py / drawHeight;

rtcControlChannel.send(
  JSON.stringify({
    type: "mouse_move",
    x,
    y
  })
);
  });

  return rtcVideo;
}

function showVmWaiting(message = "等待 Room Agent 桌面串流") {
  rtcVideo = null;
  vmScreen.innerHTML = `
    <div class="vm-empty">
      <div class="monitor-icon">▣</div>
      <strong>${message}</strong>
      <span>Agent 已上線後，系統會自動嘗試建立 WebRTC 連線。</span>
    </div>
  `;
}

function applyMode(mode, announce = false) {
  if (!roomState) roomState = {};
  roomState.control_mode = mode;
  const label = modeText[mode] || mode;
  modePill.textContent = label;
  controlLabel.textContent = label;

  if (profile?.role === "student") {
    const canControl = mode === "student" || mode === "shared";
    studentHint.textContent = canControl
      ? `目前控制模式：${label}，您可以操作`
      : `目前控制模式：${label}，您目前只能觀看`;
  }

  if (announce) {
    const canControl =
      mode === "shared" ||
      (mode === "teacher" && profile?.role === "teacher") ||
      (mode === "student" && profile?.role === "student");

    showToast(
      canControl
        ? `已切換為【${label}】，您現在可以操作`
        : `已切換為【${label}】，您目前無法操作`
    );
  }
}

async function loadUserContext(user) {
  rtcUserId = user.id;

  const { data: p, error: profileError } = await supabaseClient
    .from("profiles")
    .select("id, display_name, role")
    .eq("id", user.id)
    .single();

  if (profileError) throw profileError;
  profile = p;

  const { data: memberships, error: memberError } = await supabaseClient
    .from("room_members")
    .select("room_id")
    .eq("user_id", user.id)
    .limit(1);

  if (memberError) throw memberError;
  if (!memberships?.length) throw new Error("此帳號尚未分配教室");

  const roomId = memberships[0].room_id;

  const { data: r, error: roomError } = await supabaseClient
    .from("rooms")
    .select("id, room_code, room_name")
    .eq("id", roomId)
    .single();

  if (roomError) throw roomError;
  room = r;

  const { data: rs, error: stateError } = await supabaseClient
    .from("room_state")
    .select("room_id, control_mode, updated_at")
    .eq("room_id", roomId)
    .single();

  if (stateError) throw stateError;
  roomState = rs;
}

async function getAgentForRoom() {
  const { data, error } = await supabaseClient
    .from("room_agents")
    .select("user_id, last_seen_at, is_online")
    .eq("room_id", room.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function refreshAgentStatus() {
  if (!room?.id) return;

  const { data, error } = await supabaseClient
    .from("room_agents")
    .select("user_id, last_seen_at, is_online")
    .eq("room_id", room.id)
    .maybeSingle();

  if (error) {
    roomStatus.textContent = "● Room Agent 狀態讀取失敗";
    roomStatus.style.color = "#b42318";
    return;
  }

  if (!data?.last_seen_at) {
    roomStatus.textContent = "● Room Agent 離線";
    roomStatus.style.color = "#667085";
    return;
  }

  rtcAgentUserId = data.user_id;
  const ageMs = Date.now() - new Date(data.last_seen_at).getTime();
  const online = data.is_online === true && ageMs <= 60000;

  roomStatus.textContent = online
    ? "● Room Agent 已連線"
    : "● Room Agent 離線";
  roomStatus.style.color = online ? "#16794b" : "#667085";

  }

function startAgentStatusMonitor() {
  if (agentStatusTimer) clearInterval(agentStatusTimer);
  refreshAgentStatus();
  agentStatusTimer = setInterval(refreshAgentStatus, 15000);
}

async function sendSignal(type, payload, targetUserId) {
  const { error } = await supabaseClient.from("webrtc_signals").insert({
    room_id: room.id,
    sender_id: rtcUserId,
    target_user_id: targetUserId,
    peer_id: rtcPeerId,
    signal_type: type,
    payload
  });

  if (error) throw error;
}

async function handleViewerSignal(signal) {
  if (!rtcPeer || signal.peer_id !== rtcPeerId) return;
  if (signal.sender_id !== rtcAgentUserId) return;

  if (signal.signal_type === "answer") {
    await rtcPeer.setRemoteDescription(signal.payload);

    for (const candidate of pendingRemoteIce) {
      await rtcPeer.addIceCandidate(candidate);
    }
    pendingRemoteIce = [];
  }

  if (signal.signal_type === "ice") {
    const candidate = new RTCIceCandidate(signal.payload);

    if (rtcPeer.remoteDescription) {
      await rtcPeer.addIceCandidate(candidate);
    } else {
      pendingRemoteIce.push(candidate);
    }
  }

  if (signal.signal_type === "bye") {
    closeWebRtcViewer();
    showVmWaiting("Room Agent 已結束桌面串流");
  }
}

async function subscribeViewerSignals() {
  if (rtcSignalChannel) {
    await supabaseClient.removeChannel(rtcSignalChannel);
    rtcSignalChannel = null;
  }

  rtcSignalChannel = supabaseClient
    .channel(`webrtc-viewer-${rtcUserId}-${rtcPeerId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "webrtc_signals"
      },
      (payload) => {
        const signal = payload.new;

        if (signal.target_user_id !== rtcUserId) return;

        handleViewerSignal(signal).catch(console.error);
      }
    );

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("VIEWER SIGNAL CHANNEL 訂閱逾時")
      );
    }, 8000);

    rtcSignalChannel.subscribe((status) => {
      console.log(
        "VIEWER SIGNAL CHANNEL:",
        status
      );

      if (status === "SUBSCRIBED") {
  const wasRecovered = viewerSignalHadError;

  viewerSignalHadError = false;

  clearTimeout(timeout);
  resolve();

  if (wasRecovered) {
    console.log("VIEWER SIGNAL RESTORED");

    if (
      profile?.role === "teacher" &&
      !classroomRecoveryInProgress
    ) {
      recoverClassroomConnections(
        "viewer_signal_restored"
      );
    }
  }

  return;
}

      if (
  status === "CHANNEL_ERROR" ||
  status === "TIMED_OUT" ||
  status === "CLOSED"
) {
  viewerSignalHadError = true;
        clearTimeout(timeout);

        reject(
          new Error(
            `VIEWER SIGNAL CHANNEL: ${status}`
          )
        );
      }
    });
  });

  console.log("VIEWER SIGNAL READY");
}

async function startWebRtcViewer(force = false) {
  if (!room?.id || !rtcUserId) return;

  // 一般呼叫：已有 Peer 就不重複建立
  if (rtcPeer && !force) return;

  // 強制重連：清掉舊的 Room1 WebRTC
  if (force) {
    console.log("ROOM1 FORCED RECONNECT");

    if (controlPingTimer) {
      clearInterval(controlPingTimer);
      controlPingTimer = null;
    }

    controlPingTimes.clear();
    controlWatchdogTriggered = false;

    if (rtcControlChannel) {
      try {
        rtcControlChannel.close();
      } catch (_) {}

      rtcControlChannel = null;
    }

    if (rtcPeer) {
      try {
        rtcPeer.close();
      } catch (_) {}

      rtcPeer = null;
    }
  }

  const agent = await getAgentForRoom();
  if (!agent?.user_id) return;

  rtcAgentUserId = agent.user_id;
  rtcPeerId = crypto.randomUUID();
  pendingRemoteIce = [];

  if (!RTC_CONFIG) {
    await loadRtcConfig();
  }
  rtcPeer = new RTCPeerConnection(RTC_CONFIG);
  rtcControlChannel = rtcPeer.createDataChannel("control", {
    ordered: false,
    maxRetransmits: 0
  });

rtcControlChannel.onopen = () => {
  console.log("CONTROL DATA CHANNEL OPEN");
  showToast("遠端控制通道已連線");
  controlPingTimes.clear();
  controlWatchdogTriggered = false;
  controlPingId = 0;
  lastControlPongAt = performance.now();

  if (controlPingTimer) {
    clearInterval(controlPingTimer);
  }

 controlPingTimer = setInterval(() => {
  // 先檢查是否超過 5 秒沒有收到 Pong
  const timeSinceLastPong =
  performance.now() - lastControlPongAt;

if (
  timeSinceLastPong > CONTROL_PONG_TIMEOUT &&
  !controlWatchdogTriggered
) {
  controlWatchdogTriggered = true;

  console.warn(
    "CONTROL WATCHDOG TIMEOUT - network path may be broken",
    `${Math.round(timeSinceLastPong)} ms without pong`
  );
}

  // 檢查完 watchdog 後，才判斷 DataChannel 能不能繼續送 Ping
  if (
  !rtcControlChannel ||
  rtcControlChannel.readyState !== "open"
) {
  return;
}

  const id = ++controlPingId;

    controlPingTimes.set(id, performance.now());

    rtcControlChannel.send(
      JSON.stringify({
        type: "control_ping",
        id
      })
    );
  }, 1000);
};
rtcControlChannel.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data);
    

    // WebRTC Control DataChannel Ping / Pong
    if (msg.type === "control_pong") {
      lastControlPongAt = performance.now();
      controlWatchdogTriggered = false;
      const start = controlPingTimes.get(msg.id);

      if (start !== undefined) {
        const rtt = performance.now() - start;

        console.log(
          `CONTROL RTT: ${rtt.toFixed(1)} ms`
        );

        for (const id of controlPingTimes.keys()) {
  if (id <= msg.id) {
    controlPingTimes.delete(id);
  }
}
      }

      return;
    }

  } catch (err) {
    console.error("CONTROL MESSAGE ERROR", err);
  }
};

rtcControlChannel.onclose = () => {
  console.log("CONTROL DATA CHANNEL CLOSED");
};

rtcControlChannel.onerror = (err) => {
  console.error("CONTROL DATA CHANNEL ERROR", err);
};
  rtcPeer.addTransceiver("video", { direction: "recvonly" });

  rtcPeer.ontrack = (event) => {
    const video = ensureVmVideo();
    if (event.streams?.[0]) {
      video.srcObject = event.streams[0];
    } else {
      const stream = new MediaStream([event.track]);
      video.srcObject = stream;
    }
    video.play().catch(() => {});
  };

  rtcPeer.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendSignal("ice", event.candidate.toJSON(), rtcAgentUserId).catch(console.error);
  };

  rtcPeer.onconnectionstatechange = () => {
    const state = rtcPeer?.connectionState;
    console.log("WebRTC viewer state:", state);

    if (state === "connected") {
      showToast("Room1 桌面串流已連線");
    }

    if (state === "failed" || state === "closed") {
      closeWebRtcViewer();
      showVmWaiting("桌面串流已中斷");
    }
  };

  await subscribeViewerSignals();

  const offer = await rtcPeer.createOffer();
  await rtcPeer.setLocalDescription(offer);

  await sendSignal(
    "offer",
    {
      type: rtcPeer.localDescription.type,
      sdp: rtcPeer.localDescription.sdp
    },
    rtcAgentUserId
  );
}

function closeWebRtcViewer() {
  if (rtcPeer) {
    try { rtcPeer.close(); } catch {}
  }
  rtcPeer = null;
  rtcPeerId = null;
  pendingRemoteIce = [];

  if (rtcSignalChannel) {
    supabaseClient.removeChannel(rtcSignalChannel);
    rtcSignalChannel = null;
  }
}

async function enterClassroom(session) {
  try {
    await loadUserContext(session.user);
  } catch (err) {
    await supabaseClient.auth.signOut();
    loginError.textContent = `登入成功，但讀取教室資料失敗：${err.message}`;
    return;
  }

  loginView.classList.add("hidden");
classroomView.classList.remove("hidden");

// 啟動老師／學生本機攝影機與麥克風
await startLocalMedia();
await subscribeMediaSignals();
await sendMediaSignal("ready", {});

userBadge.textContent =
    `${profile.display_name}｜${profile.role === "teacher" ? "老師" : "學生"}｜${room.room_code}`;

  roomNameEl.textContent = room.room_name;

  if (profile.role !== "teacher") {
    controlWrap.classList.add("hidden");
  } else {
    controlWrap.classList.remove("hidden");
  }

  applyMode(roomState.control_mode, false);
  showVmWaiting();
  subscribeRoomState();
  startAgentStatusMonitor();
  startWebRtcViewer().catch((err) => {
  console.error("INITIAL WEBRTC START FAILED:", err);
  showVmWaiting("桌面串流連線失敗");
});
}

function subscribeRoomState() {
  if (roomStateChannel) supabaseClient.removeChannel(roomStateChannel);

  roomStateChannel = supabaseClient
    .channel(`room-state-${room.id}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "room_state",
        filter: `room_id=eq.${room.id}`
      },
      (payload) => {
        applyMode(payload.new.control_mode, true);
      }
    )
    .subscribe();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  const account = document.querySelector("#account").value;
  const password = document.querySelector("#password").value;

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: accountToEmail(account),
    password
  });

  if (error) {
    loginError.textContent = "帳號或密碼錯誤";
    return;
  }

  await enterClassroom(data.session);
});

controlBtn.addEventListener("click", () => {
  controlMenu.classList.toggle("hidden");
});

controlMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button || profile?.role !== "teacher") return;

  const mode = button.dataset.mode;
  // 切換控制權前，先釋放遠端 Windows 所有按鍵
sendControlMessage({
  type: "release_all_keys"
});
  controlMenu.classList.add("hidden");

  const { error } = await supabaseClient
    .from("room_state")
    .update({
      control_mode: mode,
      updated_at: new Date().toISOString()
    })
    .eq("room_id", room.id);

  if (error) showToast(`切換失敗：${error.message}`);
});

document.addEventListener("click", (event) => {
  if (!controlWrap.contains(event.target)) {
    controlMenu.classList.add("hidden");
  }
});

document.querySelector("#logoutBtn").addEventListener("click", async () => {
  if (agentStatusTimer) clearInterval(agentStatusTimer);
  closeWebRtcViewer();
  await supabaseClient.auth.signOut();
  location.reload();
});

(async () => {
  if (
    !cfg.SUPABASE_URL ||
    cfg.SUPABASE_URL.includes("YOUR_PROJECT") ||
    !cfg.SUPABASE_ANON_KEY ||
    cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")
  ) {
    loginError.textContent = "尚未設定 Supabase URL / Publishable Key";
    return;
  }

  const { data } = await supabaseClient.auth.getSession();
  if (data.session) await enterClassroom(data.session);
})();
