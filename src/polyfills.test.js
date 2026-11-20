// The component tests mock react-speech-recognition, so this is the one test
// that loads the real package, the way the browser does after src/index.jsx's
// first import.
test("react-speech-recognition loads once the polyfills ran", async () => {
  await import("./polyfills");

  const speech = await import("react-speech-recognition");

  expect(speech.default).toBeDefined();
});
