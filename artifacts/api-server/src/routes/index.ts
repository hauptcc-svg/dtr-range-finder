import { Router, type IRouter } from "express";
import healthRouter from "./health";
import agentRouter from "./agent";
import tradesRouter from "./trades";
import positionsRouter from "./positions";
import instrumentConfigsRouter from "./instrument-configs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(agentRouter);
router.use(tradesRouter);
router.use(positionsRouter);
router.use(instrumentConfigsRouter);

export default router;
