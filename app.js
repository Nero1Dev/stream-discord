// Screen-sharing rooms over WebRTC using PeerJS (free public signaling server).
//
// The room creator ("owner") has peer id = room id and acts as the hub: every
// guest keeps a data connection to it, and it holds the room state
// (participants + who is presenting) and relays share requests.
// Whoever is presenting calls every other participant directly with their
// screen stream. To take over, a participant picks a screen first and sends a
// request; the current presenter approves or denies it.

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = document.querySelector(".stage");
const roomId = new URLSearchParams(location.search).get("room");
const isOwner = !roomId;

let peer = null;
let myId = null;
let connStatus = "Conectando ao servidor…"; // overrides the status line when set

let state = { participants: [], presenter: null }; // room as this client sees it
let myStream = null; // screen I'm sharing, or waiting for approval to share
let requesting = false;
let userUnmuted = false;
const outgoingCalls = new Map(); // peerId -> MediaConnection (while I present)
const remoteStreams = new Map(); // peerId -> { call, stream }
const pendingRequests = new Map(); // peerId -> name (while I present)

// Owner only
const room = { participants: [], presenter: null };
const guestConns = new Map(); // peerId -> DataConnection
// Guest only
let hostConn = null;
let retryTimer = null;

// ---------------------------------------------------------------- Setup

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

$("name").value =
  storage.get("name") || (isOwner ? "Anfitrião" : "Convidado " + Math.floor(Math.random() * 900 + 100));

if (!isOwner) {
  $("title").innerHTML = "Assistindo <em>ao vivo</em>.";
  $("subtitle").textContent = "Você entrou numa sala. Assista ou peça para compartilhar a sua tela.";
}

if (typeof Peer === "undefined") {
  connStatus = "Não foi possível carregar o PeerJS. Verifique sua internet ou desative o bloqueador de anúncios.";
  render();
} else {
  isOwner ? startOwner() : startGuest();
}
startEmbers();

// ---------------------------------------------------------------- Transport

// Send a message to the room hub (handled locally when I am the owner).
function send(msg) {
  if (isOwner) ownerHandle(msg, myId);
  else if (hostConn?.open) hostConn.send(msg);
}

function startOwner() {
  // Random, hard-to-guess room id so only people with the link can join.
  peer = new Peer("tela-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12));

  peer.on("open", (id) => {
    myId = id;
    connStatus = null;
    room.participants = [{ id, name: myName() }];
    setLink(`${location.origin}${location.pathname}?room=${id}`);
    broadcast();
  });

  peer.on("connection", (conn) => {
    conn.on("open", () => guestConns.set(conn.peer, conn));
    conn.on("data", (msg) => ownerHandle(msg, conn.peer));
    conn.on("close", () => removeGuest(conn.peer));
    conn.on("error", () => removeGuest(conn.peer));
  });

  setupPeerCommon();
  window.addEventListener("beforeunload", () => peer.destroy());
}

function startGuest() {
  peer = new Peer();
  setLink(location.href);

  peer.on("open", (id) => {
    myId = id;
    connectToHost();
  });

  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") {
      connStatus = "Sala não encontrada (o link expirou ou quem criou fechou a aba). Tentando de novo…";
      render();
      scheduleRetry();
    }
  });

  setupPeerCommon();
  window.addEventListener("beforeunload", () => peer.destroy());
}

function connectToHost() {
  clearTimeout(retryTimer);
  hostConn = peer.connect(roomId, { reliable: true });
  hostConn.on("open", () => {
    connStatus = null;
    hostConn.send({ type: "hello", name: myName() });
  });
  hostConn.on("data", onMessage);
  hostConn.on("close", () => {
    connStatus = "A sala foi encerrada. Tentando reconectar…";
    requesting = false;
    stopMyStream();
    applyState({ participants: [], presenter: null });
    scheduleRetry();
  });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectToHost, 5000);
}

function setupPeerCommon() {
  peer.on("call", (call) => {
    call.answer(); // receive only
    call.on("stream", (stream) => {
      const old = remoteStreams.get(call.peer);
      if (old && old.call !== call) old.call.close();
      remoteStreams.set(call.peer, { call, stream });
      render();
    });
    call.on("close", () => {
      if (remoteStreams.get(call.peer)?.call === call) remoteStreams.delete(call.peer);
      render();
    });
  });

  peer.on("disconnected", () => peer.reconnect());
  peer.on("error", (err) => {
    if (err.type !== "peer-unavailable") toast("Erro de conexão: " + err.type);
  });
}

// ---------------------------------------------------------------- Owner hub

function ownerHandle(msg, from) {
  const known = room.participants.find((p) => p.id === from);
  if (!known && msg.type !== "hello") return;

  switch (msg.type) {
    case "hello":
      if (known) known.name = cleanName(msg.name);
      else room.participants.push({ id: from, name: cleanName(msg.name) });
      broadcast();
      break;
    case "request":
      if (!room.presenter) {
        room.presenter = from;
        broadcast();
      } else if (room.presenter !== from) {
        deliver(room.presenter, { type: "request", from, name: known.name });
      }
      break;
    case "cancel":
      if (room.presenter) deliver(room.presenter, { type: "cancel", from });
      break;
    case "approve":
      if (from === room.presenter && room.participants.some((p) => p.id === msg.to)) {
        room.presenter = msg.to;
        broadcast();
      }
      break;
    case "deny":
      if (from === room.presenter) deliver(msg.to, { type: "denied" });
      break;
    case "stop":
      if (from === room.presenter) {
        room.presenter = null;
        broadcast();
      }
      break;
  }
}

function deliver(id, msg) {
  if (id === myId) onMessage(msg);
  else guestConns.get(id)?.send(msg);
}

function broadcast() {
  const msg = { type: "state", participants: room.participants, presenter: room.presenter };
  for (const conn of guestConns.values()) if (conn.open) conn.send(msg);
  onMessage(structuredClone(msg));
}

function removeGuest(id) {
  guestConns.delete(id);
  if (!room.participants.some((p) => p.id === id)) return;
  room.participants = room.participants.filter((p) => p.id !== id);
  if (room.presenter === id) room.presenter = null;
  broadcast();
}

// ---------------------------------------------------------------- Messages

function onMessage(msg) {
  switch (msg.type) {
    case "state":
      applyState(msg);
      break;
    case "request":
      pendingRequests.set(msg.from, msg.name);
      toast(`${msg.name} quer compartilhar a tela`);
      render();
      break;
    case "cancel":
      pendingRequests.delete(msg.from);
      render();
      break;
    case "denied":
      requesting = false;
      stopMyStream();
      toast("Seu pedido para compartilhar foi recusado.");
      break;
  }
}

function applyState(next) {
  const prevPresenter = state.presenter;
  state = { participants: next.participants, presenter: next.presenter };
  const wasPresenter = prevPresenter === myId;
  const amPresenter = state.presenter === myId;

  if (amPresenter && !wasPresenter) {
    requesting = false;
    if (!myStream) send({ type: "stop" }); // approved, but my capture ended meanwhile
    else if (prevPresenter) toast("Pedido aceito! Você está compartilhando.");
  }
  if (wasPresenter && !amPresenter) {
    stopMyStream();
    pendingRequests.clear();
  }
  // Presenter changed while I was waiting: ask the new one (or take over if free).
  if (requesting && state.presenter !== prevPresenter) send({ type: "request" });

  for (const id of pendingRequests.keys()) {
    if (!state.participants.some((p) => p.id === id)) pendingRequests.delete(id);
  }
  // Drop streams from anyone who is no longer presenting.
  for (const [id, { call }] of remoteStreams) {
    if (id !== state.presenter) {
      call.close();
      remoteStreams.delete(id);
    }
  }

  syncCalls();
  render();
}

// ---------------------------------------------------------------- Sharing

// While I present, keep exactly one outgoing call per other participant.
function syncCalls() {
  const presenting = state.presenter === myId && myStream;
  for (const [id, call] of outgoingCalls) {
    if (!presenting || !state.participants.some((p) => p.id === id)) {
      call.close();
      outgoingCalls.delete(id);
    }
  }
  if (!presenting) return;
  for (const p of state.participants) {
    if (p.id !== myId && !outgoingCalls.has(p.id)) outgoingCalls.set(p.id, peer.call(p.id, myStream));
  }
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

// Pick the screen first (needs the click), then ask to present.
async function share() {
  try {
    myStream = await capture();
  } catch (err) {
    toast(
      err.name === "NotAllowedError"
        ? "Compartilhamento cancelado ou bloqueado pelo navegador."
        : "Não foi possível capturar a tela: " + err.message
    );
    return;
  }
  // User clicked the browser's own "Stop sharing" bar.
  myStream.getVideoTracks()[0].addEventListener("ended", () => {
    if (state.presenter === myId) stopSharing();
    else if (requesting) cancelRequest();
  });
  requesting = true;
  send({ type: "request" });
  render();
}

function cancelRequest() {
  requesting = false;
  stopMyStream();
  send({ type: "cancel" });
}

function stopSharing() {
  stopMyStream();
  send({ type: "stop" });
}

function stopMyStream() {
  myStream?.getTracks().forEach((t) => t.stop());
  myStream = null;
  syncCalls();
  render();
}

function answerRequest(id, approve) {
  pendingRequests.delete(id);
  send({ type: approve ? "approve" : "deny", to: id });
  render();
}

// ---------------------------------------------------------------- UI

function myName() {
  return cleanName($("name").value);
}
function cleanName(name) {
  return String(name || "").trim().slice(0, 24) || "Sem nome";
}
function nameOf(id) {
  return state.participants.find((p) => p.id === id)?.name ?? "Alguém";
}

function setLink(link) {
  $("shareLink").value = link;
  $("copyBtn").disabled = false;
}

function render() {
  const amPresenter = state.presenter === myId;
  const presenterName = nameOf(state.presenter);
  const connected = !connStatus && myId;

  // Video
  const mine = amPresenter && !!myStream;
  const stream = mine ? myStream : remoteStreams.get(state.presenter)?.stream ?? null;
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = mine || !userUnmuted; // never play my own audio back
  stage.classList.toggle("playing", !!stream);
  $("livePill").hidden = !stream;
  $("fullscreenBtn").hidden = !stream;
  $("unmuteBtn").hidden = !stream || mine || userUnmuted || stream.getAudioTracks().length === 0;
  $("presenterTag").hidden = !stream;
  $("presenterTag").textContent = mine ? "Você está compartilhando" : `${presenterName} está compartilhando`;
  $("placeholderText").textContent = state.presenter
    ? `Carregando a tela de ${presenterName}…`
    : "Ninguém está compartilhando ainda";

  // Buttons
  $("shareBtn").hidden = amPresenter || requesting;
  $("shareBtn").disabled = !connected;
  $("shareBtn").textContent = state.presenter ? "Pedir para compartilhar" : "Compartilhar tela →";
  $("cancelBtn").hidden = !requesting;
  $("stopBtn").hidden = !amPresenter;

  // Status line
  let status;
  if (connStatus) status = connStatus;
  else if (amPresenter) status = "Você está compartilhando a tela.";
  else if (requesting) status = `Aguardando ${presenterName} aceitar seu pedido…`;
  else if (state.presenter) status = `${presenterName} está compartilhando.`;
  else status = "Ninguém está compartilhando. Clique em Compartilhar tela para começar.";
  $("status").textContent = status;

  // Share requests (only the presenter gets them)
  const box = $("requests");
  box.replaceChildren();
  for (const [id, name] of pendingRequests) {
    const row = document.createElement("div");
    row.className = "request";
    const text = document.createElement("span");
    const who = document.createElement("b");
    who.textContent = name;
    text.append(who, " quer compartilhar a tela");
    const deny = document.createElement("button");
    deny.className = "btn btn-outline btn-sm";
    deny.textContent = "Recusar";
    deny.onclick = () => answerRequest(id, false);
    const accept = document.createElement("button");
    accept.className = "btn btn-primary btn-sm";
    accept.textContent = "Aceitar e trocar";
    accept.onclick = () => answerRequest(id, true);
    row.append(text, deny, accept);
    box.append(row);
  }
  box.hidden = pendingRequests.size === 0;
  document.title = pendingRequests.size ? `(${pendingRequests.size}) Pedido para compartilhar` : "Stream de Tela";

  // Participants
  const list = $("people");
  list.replaceChildren();
  for (const p of state.participants) {
    const li = document.createElement("li");
    li.textContent = p.name + (p.id === myId ? " (você)" : "");
    if (p.id === state.presenter) li.classList.add("presenting");
    list.append(li);
  }
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 4000);
}

$("shareBtn").onclick = share;
$("cancelBtn").onclick = cancelRequest;
$("stopBtn").onclick = stopSharing;
$("fullscreenBtn").onclick = () => stage.requestFullscreen?.();
$("unmuteBtn").onclick = () => {
  userUnmuted = true;
  render();
  video.play();
};
$("name").onchange = () => {
  storage.set("name", myName());
  send({ type: "hello", name: myName() });
};
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
