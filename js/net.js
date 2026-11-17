// Peer-to-peer networking over WebRTC (PeerJS). One player hosts, others join by room code.
(function () {
  const PREFIX = 'dnd-velkynvelve-v1-';
  const params = new URLSearchParams(location.search);

  function peerOptions() {
    // ?peer=local -> local PeerServer (used for automated tests)
    if (params.get('peer') === 'local') return { host: 'localhost', port: 9000, path: '/', secure: false, debug: 1 };
    return {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      },
    };
  }

  function randomCode() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }

  class Net {
    constructor() {
      this.isHost = false; this.peer = null; this.conns = new Map(); this.hostConn = null;
      this.onMessage = () => {}; this.onJoin = () => {}; this.onLeave = () => {}; this.onError = () => {}; this.onOpen = () => {};
      this.code = null;
    }

    host(cb) {
      this.isHost = true;
      const tryOpen = (attempt) => {
        this.code = randomCode();
        this.peer = new Peer(PREFIX + this.code, peerOptions());
        this.peer.on('open', () => { this.onOpen(this.code); cb && cb(null, this.code); });
        this.peer.on('error', (e) => {
          if (e.type === 'unavailable-id' && attempt < 3) { this.peer.destroy(); tryOpen(attempt + 1); }
          else this.onError(e);
        });
        this.peer.on('connection', (c) => {
          c.on('open', () => { this.conns.set(c.peer, c); this.onJoin(c.peer); });
          c.on('data', (d) => this.onMessage(c.peer, d));
          c.on('close', () => { this.conns.delete(c.peer); this.onLeave(c.peer); });
          c.on('error', () => { this.conns.delete(c.peer); this.onLeave(c.peer); });
        });
        this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) {} });
      };
      tryOpen(0);
    }

    join(code, cb) {
      this.isHost = false;
      this.code = code.toUpperCase().trim();
      this.peer = new Peer(undefined, peerOptions());
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; cb && cb(new Error('timeout')); } }, 15000);
      this.peer.on('open', () => {
        const c = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
        this.hostConn = c;
        c.on('open', () => { if (!done) { done = true; clearTimeout(timer); cb && cb(null); } });
        c.on('data', (d) => this.onMessage('host', d));
        c.on('close', () => this.onLeave('host'));
        c.on('error', (e) => this.onError(e));
      });
      this.peer.on('error', (e) => {
        if (!done) { done = true; clearTimeout(timer); cb && cb(e); } else this.onError(e);
      });
    }

    myId() { return this.peer ? this.peer.id : 'local'; }

    send(to, msg) { const c = this.conns.get(to); if (c && c.open) c.send(msg); }
    broadcast(msg) { for (const c of this.conns.values()) if (c.open) c.send(msg); }
    toHost(msg) { if (this.hostConn && this.hostConn.open) this.hostConn.send(msg); }
  }

  window.Net = Net;
})();
