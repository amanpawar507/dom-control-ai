const URL_ = "http://localhost:8081/parabank/index.htm";
const deadline = Date.now() + 180_000;

while (Date.now() < deadline) {
  try {
    const res = await fetch(URL_, { redirect: "follow" });
    if (res.ok) { console.log("target ready"); process.exit(0); }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("target did not become ready within 180s");
process.exit(1);
