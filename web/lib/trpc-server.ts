import "server-only";

import { createCallerFactory } from "@/server/trpc";
import { appRouter } from "@/server/routers/_app";

const createCaller = createCallerFactory(appRouter);

// Server-side caller for use inside Server Components / route handlers.
export const serverApi = createCaller({ req: new Request("http://localhost") });
