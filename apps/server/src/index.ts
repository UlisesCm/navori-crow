import { startServer } from "./server";

const port = Number(process.env["CROW_PORT"] ?? 7777);
const server = startServer(port);

console.log(`crow server listening on http://${server.hostname}:${server.port}`);
