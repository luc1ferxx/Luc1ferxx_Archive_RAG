// react-speech-recognition 3.x calls a global regeneratorRuntime as it loads.
// Create React App's Babel used to supply it; Vite does not, so without this
// import the app threw at load and showed a white page. Keep it the first
// import of src/index.jsx.
import "@babel/runtime/regenerator";
