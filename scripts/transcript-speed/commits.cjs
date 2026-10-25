// Build-only Babel instrumentation; never loaded by an ordinary application build.
module.exports = function ({ types: t }) {
  return { visitor: {
    Program(path, state) {
      const file = state.filename.replaceAll('\\', '/');
      const target = file.endsWith('/chat/_chat-surface.tsx') ? 'BuzzChatSurface'
        : file.endsWith('/buzz/room-message-cell.tsx') ? 'RoomMessageCell' : null;
      if (!target) return;
      const traceProps = process.env.BEELINE_TRANSCRIPT_PROP_TRACE === '1';
      const caller = state.file.opts.caller;
      if (caller?.name !== 'metro') throw new Error('Measurement build requires the Metro Babel caller');
      // Match babel-preset-expo's effective getReactCompiler(caller) decision.
      const metadata = {
        propTrace: traceProps,
        reactCompiler: caller.supportsReactCompiler ?? false,
        platform: caller.platform,
        engine: caller.engine ?? null,
        checkoutSha: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sourceDiffSha256: require('node:crypto').createHash('sha256').update(
          require('node:child_process').execFileSync('git', ['diff', 'HEAD', '--', 'apps/mobile', 'scripts/transcript-speed'])).digest('hex'),
      };
      path.pushContainer('body', t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(t.identifier('globalThis'), t.identifier('__transcriptBuild')), t.valueToNode(metadata))));
      let found = false;
      path.traverse({ Function(fn) {
        if (fn.node.id?.name !== target) return;
        found = true;
        const args = [
          t.stringLiteral(target === 'BuzzChatSurface' ? 'transcript' : 'row'),
          target === 'RoomMessageCell' ? t.memberExpression(t.identifier('item'), t.identifier('id')) : t.stringLiteral('room'),
        ];
        if (traceProps) {
          const values = new Map();
          const names = target === 'RoomMessageCell'
            ? fn.node.params[0].properties.flatMap(property => {
                const value = property.value;
                const binding = t.isAssignmentPattern(value) ? value.left : value;
                return t.isIdentifier(binding) ? [binding.name] : [];
              })
            : ['renderMessage', 'tailRows', 'historyRows', 'cachedMessages', 'liveMessages', 'combinedMessages', 'foldedMessages', 'visibleMessages', 'roomParticipants'];
          for (const name of names) values.set(name, t.identifier(name));
          if (target === 'BuzzChatSurface') fn.traverse({ VariableDeclarator(declaration) {
            if (declaration.node.id.name !== 'renderMessage') return;
            for (const dependency of declaration.node.init.arguments[1].elements)
              values.set(state.file.code.slice(dependency.start, dependency.end), t.cloneNode(dependency, true));
          } });
          args.push(t.arrowFunctionExpression([], t.objectExpression([...values].map(([name, value]) => t.objectProperty(t.stringLiteral(name), value)))));
        }
        fn.get('body').unshiftContainer('body', t.expressionStatement(t.callExpression(t.identifier('__transcriptCommit'), [
          ...args,
        ])));
      } });
      if (!found) throw new Error(`Transcript measurement target moved: ${target}`);
      path.unshiftContainer('body', t.importDeclaration([
        t.importSpecifier(t.identifier('__transcriptCommit'), t.identifier(traceProps ? 'useMeasuredPropCommit' : 'useMeasuredCommit')),
      ], t.stringLiteral(require('node:path').resolve(__dirname, '../../apps/mobile/transcript-speed/runtime.js'))));
    },
  } };
};
