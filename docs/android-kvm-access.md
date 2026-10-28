# Android KVM access

An approved device grant controls whether the session receives a device mount.
The mount preserves Linux permissions; it cannot confer access the helper's
host account lacks. The helper now probes an approved `/dev/kvm` and attempts
an exact read/write user ACL without sudo. If the account cannot change that
ACL, a host administrator must repair it. No other device is changed.

An ACL shown inside a user namespace as user `4294967295` belongs to an unmapped
host user. Adding that number, or the sandbox's apparent uid, is not a fix.
On the affected host, an administrator should:

1. Identify the Unix user running the Beeline helper on the host using
   `ps -eo user,uid,args` and find the machine helper process.
2. Confirm that person's approved `/dev/kvm` grant. Set `helper_user` below to
   that host Unix username, not an agent handle or a uid read inside a sandbox.
3. Run on the host:

   ```sh
   helper_uid=$(id -u "$helper_user")
   sudo setfacl -m "u:${helper_uid}:rw" /dev/kvm
   getfacl -n /dev/kvm
   sudo -u "$helper_user" python3 -c 'import os; fd=os.open("/dev/kvm",os.O_RDWR); os.close(fd); print("KVM open passed")'
   ```

4. Retry `beeline emulator -avd <name> -no-window -gpu swiftshader_indirect`
   in the approved corner. Failed starts now include the emulator's diagnostic
   output. A device ACL repair takes effect immediately; group membership
   repairs instead require a new helper login session.

Device recreation or host reboot may reset a one-time ACL. The administrator
can persist the same exact user ACL in their host's existing device setup.
Do not use world-writable permissions or grant all devices.
