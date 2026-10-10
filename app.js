// Screen-sharing rooms over WebRTC using PeerJS (free public signaling server).
//
// Every participant has its own "member" peer (random id). The room id is a
// separate peer id held by whoever currently coordinates the room (the "hub"):
// all members, including the coordinator itself, keep a data connection to it.
// The hub holds the room state (participants in join order + who is
// presenting) and relays share requests.
//
// If the coordinator leaves, the next participant in join order claims the
// room id and becomes the new hub, seeded with the last known state; everyone
// else reconnects. Media flows directly from the presenter to each member, so
// an ongoing share keeps playing during the handover. Opening a link whose
// room is empty simply reopens it.
//
// To present, a member picks a screen first (needs the click) and sends a
// request; the current presenter approves or denies it.

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = document.querySelector(".stage");
const params = new URLSearchParams(location.search);
const createdRoom = !params.get("room");
const roomId = params.get("room") || "tela-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);

let peer = null; // my member peer
let myId = null;
let connStatus = "Conectando ao servidor…"; // overrides the status line when set
let leaving = false;

let state = { hub: null, participants: [], presenter: null }; // room as this client sees it
let myStream = null; // screen I'm sharing, or waiting for approval to share
let requesting = false;
let userUnmuted = false;
const outgoingCalls = new Map(); // peerId -> MediaConnection (while I present)
const remoteStreams = new Map(); // peerId -> { call, stream }
const pendingRequests = new Map(); // peerId -> name (while I present)

let hostConn = null; // my data connection to the hub
let attempt = 0; // invalidates stale connection attempts
let retryTimer = null;
let claimAfter = 0; // earliest time I may take over the room id
let hub = null; // { peer, conns, room } while I coordinate the room

// ---------------------------------------------------------------- Setup

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

$("name").value =
  storage.get("name") || (createdRoom ? "Anfitrião" : "Convidado " + Math.floor(Math.random() * 900 + 100));

if (createdRoom) {
  // Refreshing the page rejoins the same room instead of creating another.
  history.replaceState(null, "", `${location.pathname}?room=${roomId}`);
} else {
  $("title").innerHTML = "Assistindo <em>ao vivo</em>.";
  $("subtitle").textContent = "Você entrou numa sala. Assista ou peça para compartilhar a sua tela.";
}
setLink(location.href);

if (typeof Peer === "undefined") {
  connStatus = "Não foi possível carregar o PeerJS. Verifique sua internet ou desative o bloqueador de anúncios.";
  render();
} else {
  start();
}
startEmbers();

// ---------------------------------------------------------------- Transport

function send(msg) {
  if (hostConn?.open) hostConn.send(msg);
}

function start() {
  peer = new Peer();

  peer.on("open", async (id) => {
    myId = id;
    if (createdRoom) await tryClaim();
    connectToHub();
  });

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

  peer.on("disconnected", () => !leaving && peer.reconnect());
  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") {
      // The room id has no holder: nobody is coordinating the room.
      if (err.message.includes(roomId) && hostConn && !hostConn.open) onConnectFail(attempt);
    } else {
      toast("Erro de conexão: " + err.type);
    }
  });

  window.addEventListener("beforeunload", () => {
    leaving = true;
    hub?.peer.destroy();
    peer.destroy();
  });
}

function connectToHub() {
  clearTimeout(retryTimer);
  const my = ++attempt;
  const conn = peer.connect(roomId, { reliable: true });
  hostConn = conn;
  let opened = false;
  const failTimer = setTimeout(() => !opened && onConnectFail(my), 8000);

  conn.on("open", () => {
    opened = true;
    clearTimeout(failTimer);
    if (my !== attempt) return conn.close();
    connStatus = null;
    conn.send({ type: "hello", name: myName() });
    render();
  });
  conn.on("data", (msg) => conn === hostConn && onMessage(msg));
  conn.on("close", () => {
    clearTimeout(failTimer);
    if (opened && conn === hostConn) onHubLost();
  });
}

// Nobody answered at the room id: try to become the hub, otherwise retry.
async function onConnectFail(my) {
  if (my !== attempt || leaving) return;
  attempt++; // ignore late events from the failed attempt
  hostConn?.close();
  if (!hub && Date.now() >= claimAfter && (await tryClaim())) {
    if (state.participants.length) toast("Você agora coordena a sala.");
    return connectToHub();
  }
  connStatus ||= "Procurando a sala…";
  render();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectToHub, 2000);
}

// The coordinator left. The next in join order claims the room right away;
// the others only reconnect, and may claim it themselves only after the ones
// ahead of them had their chance.
function onHubLost() {
  if (leaving) return;
  const remaining = state.participants.filter((p) => p.id !== state.hub);
  const index = remaining.findIndex((p) => p.id === myId);
  const position = index < 0 ? remaining.length : index;
  claimAfter = Date.now() + position * 4000;
  connStatus = "Quem coordenava a sala saiu. Passando a coordenação…";
  render();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (position === 0 && !hub && (await tryClaim())) toast("Você agora coordena a sala.");
    connectToHub();
  }, Math.min(position, 1) * 1500);
}

// Try to take the room id. Resolves true if I am now the hub.
function tryClaim() {
  return new Promise((resolve) => {
    const hubPeer = new Peer(roomId);
    let settled = false;
    hubPeer.on("open", () => {
      settled = true;
      startHub(hubPeer);
      resolve(true);
    });
    hubPeer.on("error", () => {
      if (settled) return;
      settled = true;
      hubPeer.destroy();
      resolve(false); // usually "unavailable-id": someone else holds the room
    });
  });
}

// ---------------------------------------------------------------- Hub

function startHub(hubPeer) {
  // Seed with the last known room (minus the coordinator that left), so an
  // ongoing share is not interrupted while members reconnect.
  const seed = state.participants.filter((p) => p.id !== state.hub);
  const room = {
    participants: seed.map((p) => ({ id: p.id, name: p.name, seen: false })),
    presenter: seed.some((p) => p.id === state.presenter) ? state.presenter : null,
  };
  hub = { peer: hubPeer, conns: new Map(), room };

  // Forget anyone from the seed who did not come back.
  setTimeout(() => {
    for (const p of [...room.participants]) if (!p.seen) removeMember(p.id);
  }, 12000);

  hubPeer.on("connection", (conn) => {
    conn.on("open", () => {
      const old = hub.conns.get(conn.peer);
      hub.conns.set(conn.peer, conn);
      old?.close();
    });
    conn.on("data", (msg) => hubHandle(msg, conn.peer));
    const drop = () => {
      // Ignore when I'm closing the tab (connections close one by one) or
      // when this connection was replaced by a newer one from the same member.
      if (leaving || hub.conns.get(conn.peer) !== conn) return;
      hub.conns.delete(conn.peer);
      removeMember(conn.peer);
    };
    conn.on("close", drop);
    conn.on("error", drop);
  });
  hubPeer.on("disconnected", () => !leaving && hubPeer.reconnect());
}

function hubHandle(msg, from) {
  const { room } = hub;
  const known = room.participants.find((p) => p.id === from);
  if (!known && msg.type !== "hello") return;

  switch (msg.type) {
    case "hello":
      if (known) Object.assign(known, { name: cleanName(msg.name), seen: true });
      else room.participants.push({ id: from, name: cleanName(msg.name), seen: true });
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
  const conn = hub.conns.get(id);
  if (conn?.open) conn.send(msg);
}

function broadcast() {
  const { room } = hub;
  const msg = {
    type: "state",
    hub: myId,
    participants: room.participants.map(({ id, name }) => ({ id, name })),
    presenter: room.presenter,
  };
  for (const conn of hub.conns.values()) if (conn.open) conn.send(msg);
}

function removeMember(id) {
  const { room } = hub;
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
  state = { hub: next.hub, participants: next.participants, presenter: next.presenter };
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
  video.muted = mine || !userUnmuted; // never play my own audio back
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    if (stream) video.play().catch(() => {});
  }
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
    if (p.id === state.hub) {
      li.classList.add("hub");
      li.title = "Coordena a sala";
    }
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
