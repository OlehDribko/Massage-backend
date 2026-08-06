import express from "express";
const app = express();
const port = 3001;
app.get("/", (req, res) => {
    res.send("Hello Bro");
});
app.listen(port);
console.log(`SERVER IS RUNNING ON PORT ${port}`);
//# sourceMappingURL=server.js.map