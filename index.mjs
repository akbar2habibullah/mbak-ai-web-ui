import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"

import { WebcastPushConnection } from "tiktok-live-connector"
import { EventEmitter } from "events"

let globalConnectionCount = 0

class TikTokConnectionWrapper extends EventEmitter {
	constructor(uniqueId, options, enableLog) {
		super()

		this.uniqueId = uniqueId
		this.enableLog = enableLog

		// Connection State
		this.clientDisconnected = false
		this.reconnectEnabled = true
		this.reconnectCount = 0
		this.reconnectWaitMs = 1000
		this.maxReconnectAttempts = 5

		this.connection = new WebcastPushConnection(uniqueId, options)

		this.connection.on("streamEnd", () => {
			this.log(`streamEnd event received, giving up connection`)
			this.reconnectEnabled = false
		})

		this.connection.on("disconnected", () => {
			globalConnectionCount -= 1
			this.log(`TikTok connection disconnected`)
			this.scheduleReconnect()
		})

		this.connection.on("error", (err) => {
			this.log(`Error event triggered: ${err.info}, ${err.exception}`)
			console.error(err)
		})
	}

	connect(isReconnect) {
		this.connection
			.connect()
			.then((state) => {
				this.log(`${isReconnect ? "Reconnected" : "Connected"} to roomId ${state.roomId}, websocket: ${state.upgradedToWebsocket}`)

				globalConnectionCount += 1

				// Reset reconnect vars
				this.reconnectCount = 0
				this.reconnectWaitMs = 1000

				// Client disconnected while establishing connection => drop connection
				if (this.clientDisconnected) {
					this.connection.disconnect()
					return
				}

				// Notify client
				if (!isReconnect) {
					this.emit("connected", state)
				}
			})
			.catch((err) => {
				this.log(`${isReconnect ? "Reconnect" : "Connection"} failed, ${err}`)

				if (isReconnect) {
					// Schedule the next reconnect attempt
					this.scheduleReconnect(err)
				} else {
					// Notify client
					this.emit("disconnected", err.toString())
				}
			})
	}

	scheduleReconnect(reason) {
		if (!this.reconnectEnabled) {
			return
		}

		if (this.reconnectCount >= this.maxReconnectAttempts) {
			this.log(`Give up connection, max reconnect attempts exceeded`)
			this.emit("disconnected", `Connection lost. ${reason}`)
			return
		}

		this.log(`Try reconnect in ${this.reconnectWaitMs}ms`)

		setTimeout(() => {
			if (!this.reconnectEnabled || this.reconnectCount >= this.maxReconnectAttempts) {
				return
			}

			this.reconnectCount += 1
			this.reconnectWaitMs *= 2
			this.connect(true)
		}, this.reconnectWaitMs)
	}

	disconnect() {
		this.log(`Client connection disconnected`)

		this.clientDisconnected = true
		this.reconnectEnabled = false

		if (this.connection.getState().isConnected) {
			this.connection.disconnect()
		}
	}

	log(logString) {
		if (this.enableLog) {
			console.log(`WRAPPER @${this.uniqueId}: ${logString}`)
		}
	}
}

const getGlobalConnectionCount = () => {
	return globalConnectionCount
}

let ipRequestCounts = {}

let maxIpConnections = 10
let maxIpRequestsPerMinute = 5

setInterval(() => {
	ipRequestCounts = {}
}, 60 * 1000)

function clientBlocked(io, currentSocket) {
	let ipCounts = getOverallIpConnectionCounts(io)
	let currentIp = getSocketIp(currentSocket)

	if (typeof currentIp !== "string") {
		console.info("LIMITER: Failed to retrieve socket IP.")
		return false
	}

	let currentIpConnections = ipCounts[currentIp] || 0
	let currentIpRequests = ipRequestCounts[currentIp] || 0

	ipRequestCounts[currentIp] = currentIpRequests + 1

	if (currentIpConnections > maxIpConnections) {
		console.info(`LIMITER: Max connection count of ${maxIpConnections} exceeded for client ${currentIp}`)
		return true
	}

	if (currentIpRequests > maxIpRequestsPerMinute) {
		console.info(`LIMITER: Max request count of ${maxIpRequestsPerMinute} exceeded for client ${currentIp}`)
		return true
	}

	return false
}

function getOverallIpConnectionCounts(io) {
	let ipCounts = {}

	io.of("/").sockets.forEach((socket) => {
		let ip = getSocketIp(socket)
		if (!ipCounts[ip]) {
			ipCounts[ip] = 1
		} else {
			ipCounts[ip] += 1
		}
	})

	return ipCounts
}

function getSocketIp(socket) {
	if (["::1", "::ffff:127.0.0.1"].includes(socket.handshake.address)) {
		return socket.handshake.headers["x-forwarded-for"]
	} else {
		return socket.handshake.address
	}
}

const app = express()
const httpServer = createServer(app)

// Enable cross origin resource sharing
const io = new Server(httpServer, {
	cors: {
		origin: "*",
	},
})

io.on("connection", (socket) => {
	let tiktokConnectionWrapper

	console.info("New connection from origin", socket.handshake.headers["origin"] || socket.handshake.headers["referer"])

	socket.on("setUniqueId", (uniqueId, options) => {
		// Prohibit the client from specifying these options (for security reasons)
		if (typeof options === "object" && options) {
			delete options.requestOptions
			delete options.websocketOptions
		} else {
			options = {}
		}

		// Session ID in .env file is optional
		if (process.env.SESSIONID) {
			options.sessionId = process.env.SESSIONID
			console.info("Using SessionId")
		}

		// Check if rate limit exceeded
		if (process.env.ENABLE_RATE_LIMIT && clientBlocked(io, socket)) {
			socket.emit("tiktokDisconnected", "You have opened too many connections or made too many connection requests. Please reduce the number of connections/requests or host your own server instance. The connections are limited to avoid that the server IP gets blocked by TokTok.")
			return
		}

		// Connect to the given username (uniqueId)
		try {
			tiktokConnectionWrapper = new TikTokConnectionWrapper(uniqueId, options, true)
			tiktokConnectionWrapper.connect()
		} catch (err) {
			socket.emit("tiktokDisconnected", err.toString())
			return
		}

		// Redirect wrapper control events once
		tiktokConnectionWrapper.once("connected", (state) => socket.emit("tiktokConnected", state))
		tiktokConnectionWrapper.once("disconnected", (reason) => socket.emit("tiktokDisconnected", reason))

		// Notify client when stream ends
		tiktokConnectionWrapper.connection.on("streamEnd", () => socket.emit("streamEnd"))

		// Redirect message events
		tiktokConnectionWrapper.connection.on("roomUser", (msg) => socket.emit("roomUser", msg))
		tiktokConnectionWrapper.connection.on("member", (msg) => socket.emit("member", msg))
		tiktokConnectionWrapper.connection.on("chat", (msg) => socket.emit("chat", msg))
		tiktokConnectionWrapper.connection.on("gift", (msg) => socket.emit("gift", msg))
		tiktokConnectionWrapper.connection.on("social", (msg) => socket.emit("social", msg))
		tiktokConnectionWrapper.connection.on("like", (msg) => socket.emit("like", msg))
		tiktokConnectionWrapper.connection.on("questionNew", (msg) => socket.emit("questionNew", msg))
		tiktokConnectionWrapper.connection.on("linkMicBattle", (msg) => socket.emit("linkMicBattle", msg))
		tiktokConnectionWrapper.connection.on("linkMicArmies", (msg) => socket.emit("linkMicArmies", msg))
		tiktokConnectionWrapper.connection.on("liveIntro", (msg) => socket.emit("liveIntro", msg))
		tiktokConnectionWrapper.connection.on("emote", (msg) => socket.emit("emote", msg))
		tiktokConnectionWrapper.connection.on("envelope", (msg) => socket.emit("envelope", msg))
		tiktokConnectionWrapper.connection.on("subscribe", (msg) => socket.emit("subscribe", msg))
	})

	socket.on("disconnect", () => {
		if (tiktokConnectionWrapper) {
			tiktokConnectionWrapper.disconnect()
		}
	})
})

// Emit global connection statistics
setInterval(() => {
	io.emit("statistic", { globalConnectionCount: getGlobalConnectionCount() })
}, 5000)

// Serve frontend files
app.use(express.static("public"))

// Start http listener
const port = process.env.PORT || 8081
httpServer.listen(port)
console.info(`Server running! Please visit http://localhost:${port}`)
