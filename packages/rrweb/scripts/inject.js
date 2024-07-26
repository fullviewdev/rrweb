// this can be injected into a page to test rrweb easily

const s = document.createElement('script');
s.type = 'text/javascript';
s.src = 'http://127.0.0.1:8080/rrweb.umd.cjs';
document.head.append(s);

setTimeout(() => {
  const events = [];
  rrweb.record({
    emit: (event) => {
      events.push(event);
    },
    plugins: [],
    recordCanvas: true,
    recordCrossOriginIframes: true,
    collectFonts: true,
  });
}, 1000);
