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

let profile = null;
let room = null;
let roomState = null;
let vmZoom = Number(localStorage.getItem("goldenClassroomVmZoom")) || 100;
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

// WebRTC 遠端控制
let rtcControlChannel = null;
let rtcMouseChannel = null;
let lastMouseSend = 0;
let moveId = 0;
const moveTimes = new Map();
function canRemoteControl() {
  return (
    profile?.role === "teacher" &&
    (roomState?.control_mode === "teacher" ||
      roomState?.control_mode === "shared")
  );
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

    const canControl =
      profile?.role === "teacher" &&
      (roomState?.control_mode === "teacher" ||
        roomState?.control_mode === "shared");

    if (!canControl) return;

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

    const id = ++moveId;
moveTimes.set(id, performance.now());

rtcControlChannel.send(
  JSON.stringify({
    type: "mouse_move",
    x,
    y,
    moveId: id
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

  if (online && !rtcPeer) {
    startWebRtcViewer().catch((err) => {
      console.error("WebRTC start failed:", err);
      showVmWaiting("桌面串流連線失敗");
    });
  }
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
    )
    .subscribe();
}

async function startWebRtcViewer() {
  if (!room?.id || !rtcUserId || rtcPeer) return;

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

  if (controlPingTimer) {
    clearInterval(controlPingTimer);
  }

  controlPingTimer = setInterval(() => {
    if (rtcControlChannel.readyState !== "open") return;

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
    if (msg.type === "mouse_move_ack") {
  console.log("RAW ACK RECEIVED:", msg.moveId);
}

    // RobotJS 真正執行 mouse_move 後回傳的 ACK
    if (msg.type === "mouse_move_ack") {
      const start = moveTimes.get(msg.moveId);

      if (start !== undefined) {
        console.log(
          `ROBOT RTT: ${(performance.now() - start).toFixed(1)} ms`
        );

        moveTimes.delete(msg.moveId);
      }

      return;
    }

    // WebRTC Control DataChannel Ping / Pong
    if (msg.type === "control_pong") {
      const start = controlPingTimes.get(msg.id);

      if (start !== undefined) {
        const rtt = performance.now() - start;

        console.log(
          `CONTROL RTT: ${rtt.toFixed(1)} ms`
        );

        controlPingTimes.delete(msg.id);
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
