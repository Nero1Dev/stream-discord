// Screen sharing over WebRTC using PeerJS (free public signaling server).
// Host: gets a peer id on page load (the share link) and calls every viewer
// once the screen is being captured.
// Viewer: opens a data connection to the host's peer id taken from ?room=.

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = document.querySelector(".stage");
const roomId = new URLSearchParams(location.search).get("room");

function setPlaying(stream) {
  video.srcObject = stream;
  stage.classList.toggle("playing", !!stream);
  $("livePill").hidden = !stream;
  $("fullscreenBtn").hidden = !stream;
}
$("fullscreenBtn").onclick = () => stage.requestFullscreen?.();

if (typeof Peer === "undefined") {
  $("subtitle").textContent =
    "Não foi possível carregar o PeerJS. Verifique sua internet ou desative o bloqueador de anúncios para esta página.";
} else if (roomId) {
  startViewer(roomId);
} else {
  startHost();
}

startEmbers();

// ---------------------------------------------------------------- Host

function startHost() {
  $("host").hidden = false;

  const viewers = new Map(); // peerId -> { conn, call }
  let stream = null;

  const setStatus = (text) => ($("hostStatus").textContent = text);
  const updateCount = () => ($("viewerCount").textContent = viewers.size);

  // Random, hard-to-guess room id so only people with the link can join.
  const peer = new Peer("tz-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12));

  peer.on("open", (id) => {
    $("shareLink").value = `${location.origin}${location.pathname}?room=${id}`;
    $("copyBtn").disabled = false;
    setStatus("Link pronto. Clique em Compartilhar tela.");
  });

  peer.on("connection", (conn) => {
    viewers.set(conn.peer, { conn, call: null });
    updateCount();
    conn.on("open", () => callViewer(conn.peer));
    conn.on("close", () => removeViewer(conn.peer));
    conn.on("error", () => removeViewer(conn.peer));
  });

  peer.on("disconnected", () => {
    setStatus("Reconectando ao servidor…");
    peer.reconnect();
  });
  peer.on("error", (err) => setStatus("Erro de conexão: " + err.type));

  function callViewer(peerId) {
    const v = viewers.get(peerId);
    if (!v || !stream) return;
    v.call?.close();
    v.call = peer.call(peerId, stream);
  }

  function removeViewer(peerId) {
    viewers.get(peerId)?.call?.close();
    viewers.delete(peerId);
    updateCount();
  }

  async function capture() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Este navegador não suporta compartilhar a tela (use Chrome, Edge ou Firefox no computador).");
    }
    const videoOpts = {
      height: { ideal: Number($("quality").value) },
      frameRate: { ideal: Number($("fps").value) },
    };
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: videoOpts, audio: true });
    } catch (err) {
      // Some browsers reject audio capture; retry with video only.
      if (err.name === "NotAllowedError" || err.name === "AbortError") throw err;
      return await navigator.mediaDevices.getDisplayMedia({ video: videoOpts });
    }
  }

  async function start() {
    try {
      stream = await capture();
    } catch (err) {
      setStatus(
        err.name === "NotAllowedError"
          ? "Compartilhamento cancelado ou bloqueado pelo navegador."
          : "Não foi possível capturar a tela: " + err.message
      );
      return;
    }

    setPlaying(stream);
    $("startBtn").hidden = true;
    $("stopBtn").hidden = false;
    setStatus("Transmitindo.");

    // User clicked the browser's own "Stop sharing" bar.
    stream.getVideoTracks()[0].addEventListener("ended", stop);

    for (const id of viewers.keys()) callViewer(id);
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    setPlaying(null);
    for (const v of viewers.values()) {
      v.call?.close();
      v.call = null;
      if (v.conn.open) v.conn.send({ type: "stopped" });
    }
    $("startBtn").hidden = false;
    $("stopBtn").hidden = true;
    setStatus("Pausado. O link continua valendo enquanto esta aba estiver aberta.");
  }

  $("startBtn").onclick = start;
  $("stopBtn").onclick = stop;
  $("copyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("shareLink").value);
    } catch {
      $("shareLink").select();
      document.execCommand("copy");
    }
    $("copyBtn").textContent = "Copiado!";
    setTimeout(() => ($("copyBtn").textContent = "Copiar"), 1500);
  };

  window.addEventListener("beforeunload", () => peer.destroy());
}

// ---------------------------------------------------------------- Viewer

function startViewer(hostId) {
  $("viewer").hidden = false;
  $("title").innerHTML = "Assistindo <em>ao vivo</em>.";
  $("subtitle").textContent = "Alguém está compartilhando a tela com você.";
  $("placeholderText").textContent = "Aguardando a transmissão começar…";

  const setStatus = (text) => ($("viewerStatus").textContent = text);
  const peer = new Peer();
  let retryTimer = null;

  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 5000);
  };

  function connect() {
    clearTimeout(retryTimer);
    const conn = peer.connect(hostId, { reliable: true });

    conn.on("open", () => setStatus("Conectado. Aguardando a transmissão…"));
    conn.on("data", (msg) => {
      if (msg?.type === "stopped") {
        setPlaying(null);
        setStatus("A transmissão foi pausada. Aguardando…");
      }
    });
    conn.on("close", () => {
      setPlaying(null);
      setStatus("Transmissão encerrada. Tentando reconectar…");
      scheduleRetry();
    });
  }

  peer.on("open", connect);

  peer.on("call", (call) => {
    call.answer(); // receive only
    call.on("stream", (remote) => {
      setPlaying(remote);
      setStatus("Ao vivo 🔴");
      $("unmuteBtn").hidden = !video.muted || remote.getAudioTracks().length === 0;
    });
  });

  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") {
      setStatus("Transmissão não encontrada (o link expirou ou a aba de quem transmite foi fechada). Tentando de novo…");
      scheduleRetry();
    } else {
      setStatus("Erro de conexão: " + err.type);
    }
  });

  $("unmuteBtn").onclick = () => {
    video.muted = false;
    video.play();
    $("unmuteBtn").hidden = true;
  };
}

// ---------------------------------------------------------------- Embers

function startEmbers() {
  const canvas = $("embers");
  const ctx = canvas.getContext("2d");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const colors = ["202,116,77", "191,24,33", "242,221,182"];
  let w, h, parts;

  function resize() {
    w = canvas.width = innerWidth;
    h = canvas.height = innerHeight;
    parts = Array.from({ length: Math.round((w * h) / 22000) }, spawn);
  }
  function spawn() {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.8 + 0.4,
      vy: Math.random() * 0.35 + 0.08,
      vx: (Math.random() - 0.5) * 0.15,
      a: Math.random() * 0.6 + 0.15,
      c: colors[Math.floor(Math.random() * colors.length)],
    };
  }
  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.y -= p.vy;
      p.x += p.vx;
      if (p.y < -5) Object.assign(p, spawn(), { y: h + 5 });
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c},${p.a})`;
      ctx.shadowColor = `rgba(${p.c},0.8)`;
      ctx.shadowBlur = 6;
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }

  addEventListener("resize", resize);
  resize();
  frame();
}
