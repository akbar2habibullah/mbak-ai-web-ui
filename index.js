import { WebcastPushConnection } from "tiktok-live-connector";
import { EventEmitter } from "events";

let globalConnectionCount = 0;

class TikTokConnectionWrapper extends EventEmitter {
  constructor(uniqueId, options, enableLog) {
    super();

    this.uniqueId = uniqueId;
    this.enableLog = enableLog;

    // Connection State
    this.clientDisconnected = false;
    this.reconnectEnabled = true;
    this.reconnectCount = 0;
    this.reconnectWaitMs = 1000;
    this.maxReconnectAttempts = 5;

    this.connection = new WebcastPushConnection(uniqueId, options);

    this.connection.on("streamEnd", () => {
      this.log(`streamEnd event received, giving up connection`);
      this.reconnectEnabled = false;
    });

    this.connection.on("disconnected", () => {
      globalConnectionCount -= 1;
      this.log(`TikTok connection disconnected`);
      this.scheduleReconnect();
    });

    this.connection.on("error", (err) => {
      this.log(`Error event triggered: ${err.info}, ${err.exception}`);
      console.error(err);
    });
  }

  connect(isReconnect) {
    this.connection
      .connect()
      .then((state) => {
        this.log(`${isReconnect ? "Reconnected" : "Connected"} to roomId ${state.roomId}, websocket: ${state.upgradedToWebsocket}`);

        globalConnectionCount += 1;

        // Reset reconnect vars
        this.reconnectCount = 0;
        this.reconnectWaitMs = 1000;

        // Client disconnected while establishing connection => drop connection
        if (this.clientDisconnected) {
          this.connection.disconnect();
          return;
        }

        // Notify client
        if (!isReconnect) {
          this.emit("connected", state);
        }
      })
      .catch((err) => {
        this.log(`${isReconnect ? "Reconnect" : "Connection"} failed, ${err}`);

        if (isReconnect) {
          // Schedule the next reconnect attempt
          this.scheduleReconnect(err);
        } else {
          // Notify client
          this.emit("disconnected", err.toString());
        }
      });
  }

  scheduleReconnect(reason) {
    if (!this.reconnectEnabled) {
      return;
    }

    if (this.reconnectCount >= this.maxReconnectAttempts) {
      this.log(`Give up connection, max reconnect attempts exceeded`);
      this.emit("disconnected", `Connection lost. ${reason}`);
      return;
    }

    this.log(`Try reconnect in ${this.reconnectWaitMs}ms`);

    setTimeout(() => {
      if (!this.reconnectEnabled || this.reconnectCount >= this.maxReconnectAttempts) {
        return;
      }

      this.reconnectCount += 1;
      this.reconnectWaitMs *= 2;
      this.connect(true);
    }, this.reconnectWaitMs);
  }

  disconnect() {
    this.log(`Client connection disconnected`);

    this.clientDisconnected = true;
    this.reconnectEnabled = false;

    if (this.connection.getState().isConnected) {
      this.connection.disconnect();
    }
  }

  log(logString) {
    if (this.enableLog) {
      console.log(`WRAPPER @${this.uniqueId}: ${logString}`);
    }
  }
}

const getGlobalConnectionCount = () => {
  return globalConnectionCount;
};

let ipRequestCounts = {};

let maxIpConnections = 10;
let maxIpRequestsPerMinute = 5;

setInterval(() => {
  ipRequestCounts = {};
}, 60 * 1000);

function clientBlocked(currentSocket) {
  let ipCounts = getOverallIpConnectionCounts();
  let currentIp = getSocketIp(currentSocket);

  if (typeof currentIp !== "string") {
    console.info("LIMITER: Failed to retrieve socket IP.");
    return false;
  }

  let currentIpConnections = ipCounts[currentIp] || 0;
  let currentIpRequests = ipRequestCounts[currentIp] || 0;

  ipRequestCounts[currentIp] = currentIpRequests + 1;

  if (currentIpConnections > maxIpConnections) {
    console.info(`LIMITER: Max connection count of ${maxIpConnections} exceeded for client ${currentIp}`);
    return true;
  }

  if (currentIpRequests > maxIpRequestsPerMinute) {
    console.info(`LIMITER: Max request count of ${maxIpRequestsPerMinute} exceeded for client ${currentIp}`);
    return true;
  }

  return false;
}

function getOverallIpConnectionCounts() {
  let ipCounts = {};

  server.clients.forEach((socket) => {
    let ip = getSocketIp(socket);
    if (!ipCounts[ip]) {
      ipCounts[ip] = 1;
    } else {
      ipCounts[ip] += 1;
    }
  });

  return ipCounts;
}

function getSocketIp(socket) {
  const address = socket.remoteAddress;
  if (["::1", "::ffff:127.0.0.1"].includes(address)) {
    return socket.headers["x-forwarded-for"];
  } else {
    return address;
  }
}

let tiktokConnectionWrapper

const server = Bun.serve({
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    try {
      const filePath = './public' + path;
      return new Response(Bun.file(filePath));
    } catch (err) {
      return new Response("404 Not Found", { status: 404 });
    }
  },
  websocket: {
		open(ws) {
			console.info("New connection from origin")
		},
		close(ws) {
      if (tiktokConnectionWrapper) {
        tiktokConnectionWrapper.disconnect()
      }
			console.info("Client disconnected")
		},
    message(ws, message) {
			let data = JSON.parse(message);

			if (data.type === "setUniqueId") {
				let { uniqueId, options } = data;

				// Prohibit the client from specifying these options (for security reasons)
				if (typeof options === "object" && options) {
					delete options.requestOptions;
					delete options.websocketOptions;
				} else {
					options = {};
				}

				// Session ID in .env file is optional
				if (process.env.SESSIONID) {
					options.sessionId = process.env.SESSIONID;
					console.info("Using SessionId");
				}

				// Check if rate limit exceeded
				if (process.env.ENABLE_RATE_LIMIT && clientBlocked(ws)) {
					ws.send(JSON.stringify({ type: "tiktokDisconnected", data: "You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok." }));
					return;
				}

				// Connect to the given username (uniqueId)
				try {
					tiktokConnectionWrapper = new TikTokConnectionWrapper(uniqueId, true);
					tiktokConnectionWrapper.connect();
				} catch (err) {
					ws.send(JSON.stringify({ type: "tiktokDisconnected", data: err.toString() }));
					return;
				}

				// Redirect wrapper control events once
				tiktokConnectionWrapper.once("connected", (state) => ws.send(JSON.stringify({ type: "tiktokConnected", data: state })));
				tiktokConnectionWrapper.once("disconnected", (reason) => ws.send(JSON.stringify({ type: "tiktokDisconnected", data: reason })));

				// Notify client when stream ends
				tiktokConnectionWrapper.connection.on("streamEnd", () => ws.send(JSON.stringify({ type: "streamEnd" })));

				// Redirect message events
				tiktokConnectionWrapper.connection.on("roomUser", (msg) => ws.send(JSON.stringify({ type: "roomUser", data: msg })));
				tiktokConnectionWrapper.connection.on("member", (msg) => ws.send(JSON.stringify({ type: "member", data: msg })));
				tiktokConnectionWrapper.connection.on("chat", (msg) => ws.send(JSON.stringify({ type: "chat", data: msg })));
				tiktokConnectionWrapper.connection.on("gift", (msg) => ws.send(JSON.stringify({ type: "gift", data: msg })));
				tiktokConnectionWrapper.connection.on("social", (msg) => ws.send(JSON.stringify({ type: "social", data: msg })));
				tiktokConnectionWrapper.connection.on("like", (msg) => ws.send(JSON.stringify({ type: "like", data: msg })));
				tiktokConnectionWrapper.connection.on("questionNew", (msg) => ws.send(JSON.stringify({ type: "questionNew", data: msg })));
				tiktokConnectionWrapper.connection.on("linkMicBattle", (msg) => ws.send(JSON.stringify({ type: "linkMicBattle", data: msg })));
				tiktokConnectionWrapper.connection.on("linkMicArmies", (msg) => ws.send(JSON.stringify({ type: "linkMicArmies", data: msg })));
				tiktokConnectionWrapper.connection.on("liveIntro", (msg) => ws.send(JSON.stringify({ type: "liveIntro", data: msg })));
				tiktokConnectionWrapper.connection.on("emote", (msg) => ws.send(JSON.stringify({ type: "emote", data: msg })));
				tiktokConnectionWrapper.connection.on("envelope", (msg) => ws.send(JSON.stringify({ type: "envelope", data: msg })));
				tiktokConnectionWrapper.connection.on("subscribe", (msg) => ws.send(JSON.stringify({ type: "subscribe", data: msg })));
			}
		},
	},
});

console.info(`Server running! Please visit http://localhost:${server.port}`);
