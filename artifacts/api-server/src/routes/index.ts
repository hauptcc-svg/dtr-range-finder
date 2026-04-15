import { Router, type IRouter } from "express";
import healthRouter from "./health";
import agentRouter from "./agent";
import tradesRouter from "./trades";
import positionsRouter from "./positions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(agentRouter);
router.use(tradesRouter);
router.use(positionsRouter);

export default router;
