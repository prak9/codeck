// A tmux attach supplies a fresh screen. Never splice bytes across attaches or grids.
export function createTerminalStream(flowId) {
  let epoch = 0, sequence = 0;
  return {
    accept(frame) {
      if (frame.type !== 'terminalOutput' || frame.flowId !== flowId) return null;
      if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 1
        || !Number.isSafeInteger(frame.seq) || typeof frame.data !== 'string') throw new Error('终端显示同步失败');
      if (frame.epoch < epoch) return null;
      if (frame.epoch === epoch && frame.seq <= sequence) return null;
      if (frame.epoch > epoch) {
        if (frame.reset !== true || frame.data !== '\x1bc' || frame.seq !== 2) throw new Error('终端显示同步失败');
        epoch = frame.epoch; sequence = 0;
      }
      if (frame.seq !== sequence + frame.data.length) throw new Error('终端显示同步失败');
      sequence = frame.seq;
      return { data: frame.data, reset: frame.reset === true,
        ack: { type: 'outputAck', flowId, epoch, seq: sequence } };
    },
  };
}
