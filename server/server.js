import "dotenv/config";
import { createApp } from "./app.js";

const PORT = Number.parseInt(process.env.PORT ?? "5001", 10);
const app = await createApp();

app.listen(PORT, () => {
  console.log(`server is running on port ${PORT}`);
});
