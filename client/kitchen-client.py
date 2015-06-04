#!/usr/bin/env python
#
# Copyright 2015 Haiku, Inc. All rights reserved.
# Distributed under the terms of the MIT License.
#
# Authors:
#		Augustin Cavalier <waddlesplash>

import socket, ssl, json, subprocess, multiprocessing

sock = socket.socket()
sock.connect(("10.0.2.2", 42458))

sock = ssl.wrap_socket(sock, ssl_version = ssl.PROTOCOL_TLSv1,
					   cert_reqs = ssl.CERT_NONE)

good = True
dataBuf = ''
while good:
	while (not ('\n' in dataBuf)):
		dataBuf += sock.recv(1024)
		if (len(dataBuf) == 0):
			good = False
			s.close()
	data = dataBuf.split('\n')
	dataBuf = data[-1]
	del data[-1]

	for rawMsg in data:
		reply = {}
		msg = json.loads(rawMsg)
		if (msg['what'] == 'command'):
			reply['what'] = 'commandResult'
			reply['output'] = ''
			proc = subprocess.Popen(msg['command'], shell=True,
									stdout = subprocess.PIPE,
									stderr = subprocess.STDOUT)
			for line in proc.stdout.readlines():
				reply['output'] += line
			reply['exitcode'] = proc.wait()
		elif (msg['what'] == 'getCpuCount'):
			reply['what'] = 'cpuCount'
			reply['count'] = multiprocessing.cpu_count()
		sock.send(json.dumps(reply, separators=(',',':')))
