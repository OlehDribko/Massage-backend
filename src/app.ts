import express from "express";
import cors from "cors";
import userRoute from "./modules/users/user.route.js";
import { errorHandler } from "./middleware/error.middleware.js";

const app = express();

const frontendUrl = process.env.FRONTEND_URL;

app.use(
  cors({
    origin: frontendUrl || true,
  }),
);
app.use(express.json());

app.post("/api", (req, res, next) => {
  console.log(req.body);
  res.status(200).json({ message: "Data received" });
});
app.use("/api/users", userRoute);
app.use(errorHandler);

export default app;
