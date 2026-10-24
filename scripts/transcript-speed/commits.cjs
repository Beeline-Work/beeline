// Build-only Babel instrumentation; never loaded by an ordinary application build.
module.exports = function ({ types: t }) {
  return { visitor: {
    Program(path, state) {
      const file = state.filename.replaceAll('\\', '/');
      const target = file.endsWith('/chat/_chat-surface.tsx') ? 'BuzzChatSurface'
        : file.endsWith('/buzz/room-message-cell.tsx') ? 'RoomMessageCell' : null;
      if (!target) return;
      let found = false;
      path.traverse({ Function(fn) {
        if (fn.node.id?.name !== target) return;
        found = true;
        fn.get('body').unshiftContainer('body', t.expressionStatement(t.callExpression(t.identifier('__transcriptCommit'), [
          t.stringLiteral(target === 'BuzzChatSurface' ? 'transcript' : 'row'),
          target === 'RoomMessageCell' ? t.memberExpression(t.identifier('item'), t.identifier('id')) : t.stringLiteral('room'),
        ])));
      } });
      if (!found) throw new Error(`Transcript measurement target moved: ${target}`);
      path.unshiftContainer('body', t.importDeclaration([
        t.importSpecifier(t.identifier('__transcriptCommit'), t.identifier('useMeasuredCommit')),
      ], t.stringLiteral(require('node:path').resolve(__dirname, '../../apps/mobile/transcript-speed/runtime.js'))));
    },
  } };
};
