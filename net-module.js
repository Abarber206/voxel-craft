/**
 * VoxelNet — WebRTC co-op networking for the voxel game (star topology over PeerJS).
 *
 * One machine hosts (`await net.host()` -> "abc12", full peer id "voxel-abc12"), others
 * join (`await net.join("abc12")`). Guests talk ONLY to the host; the host relays guest
 * traffic to the other guests wrapped as {t:'r', f:originPeerId, m:originalMessage} and
 * mirrors the roster with {t:'pj', id} / {t:'pl', id}.
 *
 * Wire messages (plain JSON over reliable DataChannels, serialization:'json'):
 *   {t:'s', ps:[p1,p2]} state ~15 Hz | {t:'b', e:{x,y,z,id}} block edit
 *   {t:'w', w:{seed,edits}} world sync, host -> one guest
 *
 * Requires the global `Peer` constructor (PeerJS 1.5.x via <script> tag).
 * Assign the on* callbacks BEFORE calling host()/join() so no events are missed.
 */
class VoxelNet {
  constructor() {
    // User-assignable callbacks (all optional, default no-op).
    this.onPeerJoin  = function () {}; // (peerId)
    this.onPeerLeave = function () {}; // (peerId)
    this.onState     = function () {}; // (peerId, players)
    this.onBlock     = function () {}; // (edit, fromPeerId)
    this.onDrop      = function () {}; // (drop, fromPeerId)
    this.onPickup    = function () {}; // (drop, fromPeerId)
    this.onWorld     = function () {}; // ({seed, edits})
    this.onStatus    = function () {}; // (humanReadableString)
    this._joinTimer  = null;
    this._resetState();
  }

  /** Wipe per-session state. Never touches the callbacks above. */
  _resetState() {
    this._peer          = null;      // PeerJS Peer instance (host or guest)
    this._isHost        = false;
    this._hostConn      = null;      // guest: our single DataConnection to the host
    this._conns         = new Map(); // host: guestPeerId -> open DataConnection
    this._remoteGuests  = new Set(); // guest: other guests' ids learned via pj/pl
    this._pendingReject = null;      // reject fn of an in-flight host()/join()
    if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
  }

  // ==== public getters ======================================================
  get isHost()  { return this._isHost; }
  get localId() { return (this._peer && this._peer.id) || null; }

  /** Host: signaling open (guests can find us). Guest: data channel to host open. */
  get connected() {
    if (!this._peer || this._peer.destroyed) return false;
    return this._isHost ? !!this._peer.open : !!(this._hostConn && this._hostConn.open);
  }

  /** Remote machines currently visible (host: guests; guest: host + other guests). */
  get peerCount() {
    if (this._isHost) return this._conns.size;
    return (this._hostConn && this._hostConn.open) ? 1 + this._remoteGuests.size : 0;
  }

  // ==== lifecycle ===========================================================

  /** Start hosting. Resolves with the 5-char short code players share/type. */
  host() {
    return new Promise((resolve, reject) => {
      this.close();                  // drop any previous session (silent if none)
      this._isHost = true;
      this._pendingReject = reject;
      let retriesLeft = 3;           // regenerate code on id collision, max 3 retries
      const attempt = () => {
        const code = this._makeCode();
        const peer = new Peer('voxel-' + code);   // default PeerJS public cloud
        this._peer = peer;
        peer.on('open', () => {
          if (this._peer !== peer) return;        // superseded by close()/retry
          // reconnect() re-emits 'open' — never wire/resolve twice.
          if (!this._pendingReject) { this._status('Reconnected to signaling'); return; }
          this._pendingReject = null;
          this._wireHost(peer);
          this._status('Hosting as voxel-' + code);
          resolve(code);
        });
        peer.on('error', (err) => {
          if (this._peer !== peer) return;
          const type = (err && err.type) || 'unknown';
          if (!this._pendingReject) { this._runtimeError(type); return; }   // already live
          if (type === 'unavailable-id' && retriesLeft-- > 0) {
            this._silence(peer);
            try { peer.destroy(); } catch (e) {}
            attempt();                            // fresh code, fresh peer
          } else {
            this._settleErr(reject, 'Could not start hosting (' + type + ')');
          }
        });
        this._wireReconnect(peer);
      };
      attempt();
    });
  }

  /** Join a hosted game by code. Resolves once the data channel to the host opens. */
  join(code) {
    return new Promise((resolve, reject) => {
      let short = String(code == null ? '' : code).trim().toLowerCase();
      if (short.indexOf('voxel-') === 0) short = short.slice(6);
      if (!short) { this._status('Please enter a room code'); reject(new Error('Please enter a room code')); return; }
      const hostId = 'voxel-' + short;
      this.close();
      this._isHost = false;
      this._pendingReject = reject;
      this._status('Joining ' + hostId + '…');
      // Hard 10 s cap on the whole handshake (broker + ICE + channel open).
      this._joinTimer = setTimeout(() => { this._settleErr(reject, 'Timed out connecting to ' + hostId); }, 10000);
      const peer = new Peer();                    // random id from the cloud broker
      this._peer = peer;
      peer.on('error', (err) => {
        if (this._peer !== peer) return;
        const type = (err && err.type) || 'unknown';
        if (type === 'peer-unavailable') this._settleErr(reject, 'No game found for code "' + short + '" — check it and try again');
        else if (this._pendingReject) this._settleErr(reject, 'Connection failed (' + type + ')');
        else this._runtimeError(type);
      });
      this._wireReconnect(peer);
      peer.on('open', () => {
        if (this._peer !== peer) return;
        if (!this._pendingReject) { this._status('Reconnected to signaling'); return; }
        if (this._hostConn) return;               // 'open' re-fired mid-handshake — already dialing
        const conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
        this._hostConn = conn;
        conn.on('open', () => {
          if (this._peer !== peer || this._hostConn !== conn) return;
          if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
          this._pendingReject = null;
          this._status('Connected to ' + hostId);
          this._fire('onPeerJoin', hostId);
          resolve();
        });
        conn.on('data', (msg) => { if (this._hostConn === conn) this._guestData(msg, hostId); });
        const lost = () => {
          if (this._peer !== peer) return;
          if (this._pendingReject) { this._settleErr(reject, 'Could not reach the host'); return; }
          if (this._hostConn !== conn) return;    // close+error both fire — handle once
          this._hostConn = null;
          this._silence(conn);
          const others = [...this._remoteGuests]; // host gone => its relayed guests are too
          this._remoteGuests.clear();
          for (const id of others) this._fire('onPeerLeave', id);
          this._fire('onPeerLeave', hostId);
          this._status('Disconnected from host');
        };
        conn.on('close', lost);
        conn.on('error', lost);
      });
    });
  }

  /** Tear everything down. Idempotent — safe to call repeatedly, in any state. */
  close() {
    if (this._pendingReject) {                    // cancel an in-flight host()/join()
      const rej = this._pendingReject;
      this._pendingReject = null;
      rej(new Error('Connection attempt cancelled'));
    }
    if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
    const peer = this._peer;
    if (!peer) { this._resetState(); return; }
    const conns = this._isHost ? [...this._conns.values()] : (this._hostConn ? [this._hostConn] : []);
    this._resetState();                           // null refs first so late events hit the guards
    for (const c of conns) { this._silence(c); try { c.close(); } catch (e) {} }
    this._silence(peer);
    try { peer.destroy(); } catch (e) {}
    this._status('Disconnected');
  }

  // ==== outbound (all no-ops when offline; never throw) ====================

  /** Broadcast both local players' state (~15 Hz). */
  sendState(players) { if (Array.isArray(players)) this._broadcast({ t: 's', ps: players }); }

  /** Broadcast one block edit {x,y,z,id}. */
  sendBlock(edit) {
    if (this._isEdit(edit)) this._broadcast({ t: 'b', e: { x: edit.x, y: edit.y, z: edit.z, id: edit.id } });
  }

  /** Broadcast a dropped item {id,n,x,y,z,vx,vy,vz} so peers see it hit the ground. */
  sendDrop(d) {
    if (d && typeof d.id === 'string' && Number.isFinite(d.x)) this._broadcast({ t: 'd', d });
  }

  /** Broadcast "this drop was collected" so it doesn't linger on other screens. */
  sendPickup(d) {
    if (d && typeof d.id === 'string' && Number.isFinite(d.x)) this._broadcast({ t: 'k', d });
  }

  /** Host only: push the full world {seed, edits} to one specific guest. */
  sendWorld(peerId, world) {
    if (!this._isHost || !world || typeof world !== 'object') return;
    this._safeSend(this._conns.get(peerId), { t: 'w', w: world });
  }

  _broadcast(msg) {
    if (this._isHost) { for (const c of this._conns.values()) this._safeSend(c, msg); }
    else this._safeSend(this._hostConn, msg);
  }

  _safeSend(conn, msg) {
    if (!conn || !conn.open) return;              // silently drop while the channel is down
    try { conn.send(msg); } catch (e) { /* channel died mid-send — ignore */ }
  }

  // ==== host internals ======================================================

  /** Host: accept guests, register them on open, drop them on close/error. */
  _wireHost(peer) {
    peer.on('connection', (conn) => {
      if (this._peer !== peer) { try { conn.close(); } catch (e) {} return; }
      conn.on('open', () => {
        if (this._peer !== peer) { try { conn.close(); } catch (e) {} return; }
        this._addGuest(conn);
      });
      conn.on('data', (msg) => { if (this._peer === peer) this._hostData(conn, msg); });
      const drop = () => { if (this._peer === peer) this._dropGuest(conn); };
      conn.on('close', drop);
      conn.on('error', drop);
    });
  }

  _addGuest(conn) {
    const id = conn.peer;
    const old = this._conns.get(id);
    if (old && old !== conn) { this._silence(old); try { old.close(); } catch (e) {} }
    this._conns.set(id, conn);
    for (const [otherId, c] of this._conns) {     // introduce newcomer <-> existing guests
      if (otherId === id) continue;
      this._safeSend(c, { t: 'pj', id: id });
      this._safeSend(conn, { t: 'pj', id: otherId });
    }
    this._status('Peer connected (' + this._conns.size + ')');
    this._fire('onPeerJoin', id);                 // game hooks this to sendWorld(id, ...)
  }

  _dropGuest(conn) {
    const id = conn.peer;
    if (this._conns.get(id) !== conn) return;     // never registered, or already dropped
    this._conns.delete(id);
    this._silence(conn);
    for (const c of this._conns.values()) this._safeSend(c, { t: 'pl', id: id });
    this._status('Peer disconnected (' + this._conns.size + ')');
    this._fire('onPeerLeave', id);
  }

  /** Host: dispatch a guest message locally, then relay it to every other guest. */
  _hostData(conn, msg) {
    try {
      if (this._conns.get(conn.peer) !== conn) return;   // only registered, open guests
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 's' && Array.isArray(msg.ps)) {
        this._fire('onState', conn.peer, msg.ps);
        this._relayFrom(conn.peer, msg);
      } else if (msg.t === 'b' && this._isEdit(msg.e)) {
        this._fire('onBlock', msg.e, conn.peer);
        this._relayFrom(conn.peer, msg);
      } else if ((msg.t === 'd' || msg.t === 'k') && msg.d && typeof msg.d === 'object') {
        this._fire(msg.t === 'd' ? 'onDrop' : 'onPickup', msg.d, conn.peer);
        this._relayFrom(conn.peer, msg);
      }                                                  // anything else from a guest: ignore
    } catch (e) { /* malformed input — ignore */ }
  }

  _relayFrom(fromId, msg) {
    if (this._conns.size < 2) return;
    const wrapped = { t: 'r', f: fromId, m: msg };
    for (const [id, c] of this._conns) { if (id !== fromId) this._safeSend(c, wrapped); }
  }

  // ==== guest internals =====================================================

  /** Guest: dispatch a message from the host (direct, relayed 'r', or pj/pl roster). */
  _guestData(msg, hostId) {
    try {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 's': if (Array.isArray(msg.ps)) this._fire('onState', hostId, msg.ps); break;
        case 'b': if (this._isEdit(msg.e)) this._fire('onBlock', msg.e, hostId); break;
        case 'd': if (msg.d && typeof msg.d === 'object') this._fire('onDrop', msg.d, hostId); break;
        case 'k': if (msg.d && typeof msg.d === 'object') this._fire('onPickup', msg.d, hostId); break;
        case 'w':
          if (msg.w && typeof msg.w === 'object' && msg.w.seed !== undefined &&
              Array.isArray(msg.w.edits)) this._fire('onWorld', msg.w);
          break;
        case 'r':                                 // relayed message from another guest
          if (typeof msg.f === 'string' && msg.m && typeof msg.m === 'object') {
            if (msg.m.t === 's' && Array.isArray(msg.m.ps)) this._fire('onState', msg.f, msg.m.ps);
            else if (msg.m.t === 'b' && this._isEdit(msg.m.e)) this._fire('onBlock', msg.m.e, msg.f);
            else if (msg.m.t === 'd' && msg.m.d) this._fire('onDrop', msg.m.d, msg.f);
            else if (msg.m.t === 'k' && msg.m.d) this._fire('onPickup', msg.m.d, msg.f);
          }
          break;
        case 'pj':                                // another guest joined the star
          if (typeof msg.id === 'string' && msg.id !== this.localId && !this._remoteGuests.has(msg.id)) {
            this._remoteGuests.add(msg.id);
            this._fire('onPeerJoin', msg.id);
          }
          break;
        case 'pl':                                // another guest left
          if (typeof msg.id === 'string' && this._remoteGuests.delete(msg.id)) this._fire('onPeerLeave', msg.id);
          break;
      }
    } catch (e) { /* malformed input — ignore */ }
  }

  // ==== shared helpers ======================================================

  /** Signaling dropouts: data channels survive, so just re-dial the broker. */
  _wireReconnect(peer) {
    peer.on('disconnected', () => {
      if (this._peer !== peer || peer.destroyed) return;
      this._status('Disconnected — reconnecting…');
      try { peer.reconnect(); } catch (e) {}
    });
  }

  /** Non-fatal post-setup errors ('network' pairs with 'disconnected' + auto-reconnect). */
  _runtimeError(type) {
    this._status(type === 'network' ? 'Network error — trying to recover…' : 'Network error (' + type + ')');
  }

  /** Reject an in-flight host()/join(), tear down the half-open peer, report status. */
  _settleErr(reject, msg) {
    if (!this._pendingReject) return;             // already settled or closed
    this._pendingReject = null;
    const peer = this._peer;
    this._resetState();                           // also clears the join timeout
    if (peer) { this._silence(peer); try { peer.destroy(); } catch (e) {} }
    this._status(msg);
    reject(new Error(msg));
  }

  /** Invoke a user callback without letting its exceptions break the net code. */
  _fire(name, ...args) { try { this[name](...args); } catch (e) { /* callback threw — ignore */ } }

  _status(msg) { this._fire('onStatus', msg); }

  /** Shape check for a block edit {x,y,z,id}. */
  _isEdit(e) {
    return !!e && typeof e === 'object' &&
      Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z) && e.id !== undefined;
  }

  /** Detach our listeners; keep an error sink (eventemitter3 throws on unhandled 'error'). */
  _silence(emitter) {
    try { emitter.removeAllListeners(); emitter.on('error', function () {}); } catch (e) {}
  }

  /** 5 chars from an ambiguity-free alphabet (no 0/O, 1/l/i) — ~28.6M combinations. */
  _makeCode() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(5);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 5; i++) bytes[i] = (Math.random() * 256) | 0;
    let code = '';
    for (const b of bytes) code += alphabet[b % alphabet.length];
    return code;
  }
}
