import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { getAuthProvider } from "../auth/index.js";
import { onGatewayEvent } from "./gateway.js";

/**
 * Socket.IO transport for the local RealtimeGateway.
 * Clients authenticate with { auth: { token } }, then `join` a room named
 * `post:<id>` to receive live comment/reaction/rating events for a post.
 * Feed-wide events are delivered to every authenticated client.
 */
export function attachRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Authentication required"));
    getAuthProvider()
      .validateAccessToken(token)
      .then(({ userId }) => {
        socket.data.userId = userId;
        next();
      })
      .catch(() => next(new Error("Invalid token")));
  });

  io.on("connection", (socket) => {
    socket.on("join", (postId: string) => {
      if (typeof postId === "string") void socket.join(`post:${postId}`);
    });
    socket.on("leave", (postId: string) => {
      if (typeof postId === "string") void socket.leave(`post:${postId}`);
    });
  });

  onGatewayEvent((event, payload) => {
    switch (event) {
      case "comment:added":
      case "comment:deleted":
        io.to(`post:${payload.postId}`).emit(event, payload);
        break;
      case "reaction:changed":
      case "rating:changed":
      case "post:updated":
        io.to(`post:${payload.postId}`).emit(event, payload);
        break;
      case "feed:changed":
        io.emit("feed:changed", payload);
        break;
      case "post:deleted":
        io.emit(event, payload);
        io.in(`post:${payload.postId}`).socketsLeave(`post:${payload.postId}`);
        break;
    }
  });

  return io;
}
