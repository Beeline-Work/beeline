export const Modal = {
  confirm(title: string, message: string, options: { cancelText: string; confirmText: string }) {
    return new Promise<boolean>((resolve) => {
      const root = document.getElementById('modal-root')!;
      root.innerHTML = `<div class="shade"><div class="dialog" role="dialog"><h2></h2><p></p><div class="actions"><button id="cancel"></button><button id="confirm"></button></div></div></div>`;
      root.querySelector('h2')!.textContent = title;
      root.querySelector('p')!.textContent = message;
      const cancel = root.querySelector<HTMLButtonElement>('#cancel')!;
      const confirm = root.querySelector<HTMLButtonElement>('#confirm')!;
      cancel.textContent = options.cancelText;
      confirm.textContent = options.confirmText;
      cancel.onclick = () => {
        root.innerHTML = '';
        resolve(false);
      };
      confirm.onclick = () => {
        root.innerHTML = '';
        resolve(true);
      };
    });
  },
};
