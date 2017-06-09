#!/usr/bin/env python2
#
# Copyright 2015-2017 Haiku, Inc. All rights reserved.
# Distributed under the terms of the MIT License.
#
# Authors:
#		Augustin Cavalier <waddlesplash>

import os, sys, socket, time, ssl, json, base64, subprocess, multiprocessing

confFilename = os.path.dirname(os.path.realpath(__file__)) + '/builder.conf'
if (not os.path.isfile(confFilename)):
	raise IOError("Configuration file '" + confFilename + "' does not exist!")

crtFilename = os.path.dirname(os.path.realpath(__file__)) + '/server.crt'
if (not os.path.isfile(crtFilename)):
	raise IOError("Server certificate '" + crtFilename + "' does not exist!")

with open (confFilename, 'r') as confFile:
	try:
		conf = json.loads(confFile.read())
	except:
		print "Error: Your conf file is invalid JSON (filename: {0})".format(confFilename)
		sys.exit(1)

print "Connecting to {0}...".format(conf['ip'])
sock = None
while True: # loop until we connect
	try:
		sock = socket.socket()
		sock.setblocking(1)
		sock.connect((conf['ip'], 5824))
	except:
		sock.close()
		time.sleep(5)
		continue
	break

def sendJSON(obj):
	"Writes the dictionary object passed to the socket as JSON."
	sock.send(json.dumps(obj, separators = (',',':')) + '\n')

sock = ssl.wrap_socket(sock, ssl_version = ssl.PROTOCOL_TLSv1,
					   cert_reqs = ssl.CERT_NONE)

authMsg = {'what': 'auth', 'name': conf['name'], 'key': conf['key']}
sock.recv(1) # wait until we recieve the first newline

with open (crtFilename, 'r') as certFile:
	if (sock.getpeercert(True) != base64.b64decode(certFile.read().replace('-----BEGIN CERTIFICATE-----', '')
			.replace('-----END CERTIFICATE-----', ''))):
		print "Error: Server sent a certificate that does not match server.crt"
		print "Server's certificate:"
		print base64.b64encode(sock.getpeercert(True))
		sys.exit(2)

sendJSON(authMsg)

dataBuf = ''
while True:
	while (not ('\n' in dataBuf)):
		newData = sock.recv(1024)
		if (not newData):
			print "Socket was closed."
			os.execv(__file__, sys.argv)
		dataBuf += newData
	data = dataBuf.split('\n')
	dataBuf = data[-1]
	del data[-1]

	for rawMsg in data:
		reply = {}
		msg = json.loads(rawMsg)
		if (msg['what'] == 'command'):
			reply['what'] = msg['replyWith']
			reply['output'] = ''
			command = msg['command']
			command = command.replace('KITCHEN_SERVER_ADDRESS', conf['ip'])
			print "Executing command '" + command + "'."
			if (not ('&&' in command or '|' in command or 'cd' in command or 'rm' in command)):
				command = 'stdbuf -o L ' + command
			proc = subprocess.Popen(command, shell = True,
				stdout = subprocess.PIPE, stderr = subprocess.STDOUT)
			for line in proc.stdout.readlines():
				reply['output'] += line
				sys.stdout.write(":: " + line)
				sys.stdout.flush()
			reply['exitcode'] = proc.wait()
		elif (msg['what'] == 'getCores'):
			reply['what'] = 'coreCount'
			reply['count'] = multiprocessing.cpu_count()
		elif (msg['what'] == 'restart'):
			reply['what'] = 'restarting'
			print "Recieved message 'restart', restarting OS..."
			subprocess.Popen('shutdown -r', shell = True)
		sendJSON(reply)
