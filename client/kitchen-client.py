#!/usr/bin/env python
#
# Copyright 2015 Haiku, Inc. All rights reserved.
# Distributed under the terms of the MIT License.
#
# Authors:
#		Augustin Cavalier <waddlesplash>

import os.path, socket, ssl, json, subprocess, multiprocessing

if (not os.path.isfile('builder.conf')):
	raise IOError("Configuration file 'builder.conf' does not exist!")

sock = socket.socket()
sock.connect(("10.0.2.2", 42458))

def sendJSON(obj):
	"Writes the dictionary object passed to the socket as JSON."
	sock.send(json.dumps(obj, separators = (',',':')) + '\n')

sock = ssl.wrap_socket(sock, ssl_version = ssl.PROTOCOL_TLSv1,
					   cert_reqs = ssl.CERT_NONE)

with open ('builder.conf', 'r') as confFile:
    conf = json.loads(confFile.read().replace('\n', ''))

authMsg = {'what': 'auth', 'name': conf['name'], 'key': conf['key']}
sock.recv(1) # wait until we recieve the first newline
sendJSON(authMsg)

good = True
dataBuf = ''
while good:
	while (not ('\n' in dataBuf)):
		dataBuf += sock.recv(1024)
		if (len(dataBuf) == 0):
			good = False
			sock.close()
	data = dataBuf.split('\n')
	dataBuf = data[-1]
	del data[-1]

	for rawMsg in data:
		reply = {}
		msg = json.loads(rawMsg)
		if (msg['what'] == 'command'):
			reply['what'] = msg['replyWith']
			reply['output'] = ''
			proc = subprocess.Popen(msg['command'], shell = True,
									stdout = subprocess.PIPE,
									stderr = subprocess.STDOUT)
			for line in proc.stdout.readlines():
				reply['output'] += line
			reply['exitcode'] = proc.wait()
		elif (msg['what'] == 'getCores'):
			reply['what'] = 'coreCount'
			reply['count'] = multiprocessing.cpu_count()
		sendJSON(reply)
