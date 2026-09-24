#!/usr/bin/env python3
# Run inside `unshare -rn`: brings up only the loopback interface, then execs the command.
# The new network namespace has no other interfaces, so all non-loopback egress fails.
import fcntl, socket, struct, os, sys
# lo starts down in a new namespace; set IFF_UP with SIOCGIFFLAGS/SIOCSIFFLAGS.
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
ifr = struct.pack('16sH14s', b'lo', 0, b'')
flags = struct.unpack('16sH14s', fcntl.ioctl(s, 0x8913, ifr))[1]
fcntl.ioctl(s, 0x8914, struct.pack('16sH14s', b'lo', flags | 0x1, b''))
os.execvp(sys.argv[1], sys.argv[1:])
