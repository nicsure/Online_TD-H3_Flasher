let port = null;
let writer = null;
let reader = null;
let started = false;
let firmware = null;
let lastBlock = -1;
let detected = false;
let flashing = false;
let block = 0;
let timeoutId;

const firmwareFileInput = document.getElementById("firmwareFile");
const connectButton = document.getElementById("connectButton");
const abortButton = document.getElementById("abortButton");
const flashButton = document.getElementById("flashButton");
const statusDiv = document.getElementById("status");
const initSequence = new Uint8Array([
    0xA0, 0xEE, 0x74, 0x71, 0x07, 0x74,
    0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
    0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
    0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55
]);

const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
document.body.style.backgroundColor = isDarkMode ? 'black' : 'white';
document.body.style.color = isDarkMode ? 'white' : 'black';
document.body.style.fontFamily = 'sans-serif';

function disposeSerial()
{
	try { if(writer != null) writer.releaseLock(); } catch { }
	try { if(reader != null) reader.releaseLock(); } catch { }
	try { if(port != null) port.close(); } catch { }	
}

function closeSerial() 
{
	disposeSerial();
	port = null;
	reader = null;
	writer = null;
}

async function openSerial(baud)
{
	if(port != null)
	{
		try
		{
			await port.open({ baudRate: baud });
			writer = port.writable.getWriter();
			reader = port.readable.getReader();
			return;
		}
		catch (error)
		{
			statusDiv.textContent = `Serial port error: ${error.message}`;
		}
		closeSerial();	
	}
}

function setActiveButtons()
{
	if(started)
	{
		abortButton.disabled = false;
		connectButton.disabled = true;
		flashButton.disabled = true;
		firmwareFileInput.disabled = true;
	}
	else
	{
		abortButton.disabled = true;
		connectButton.disabled = firmware == null;
		flashButton.disabled = firmware == null || port == null;
		firmwareFileInput.disabled = false;		
	}	
}

firmwareFileInput.addEventListener("change", async (event) => 
{
    try
	{
		firmware = null;
		if(event.target.files[0])
		{
			const fileData = await event.target.files[0].arrayBuffer();
			const fileBytes = new Uint8Array(fileData);
			const roundedLength = Math.ceil(fileBytes.length / 32) * 32;
			if(roundedLength > 0xf800)
			{
				throw new Error("File too large");
			}
			lastBlock = (roundedLength / 32) - 1; 
			firmware = new Uint8Array(roundedLength);
			firmware.set(fileBytes);
			statusDiv.textContent = "Firmware file loaded.";
		}
		else
			statusDiv.textContent = "";
	}
	catch(error)
	{
		statusDiv.textContent = `File error: ${error.message}`;
	}
    setActiveButtons();
});

async function selectSerialPort()
{
	try 
	{ 
		port = await navigator.serial.requestPort();
	}
	catch 
	{ 
		port = null;
	}
}

connectButton.addEventListener("click", async () => 
{
	closeSerial();
	await selectSerialPort();
	await openSerial(115200);
	if(port)
	{
		statusDiv.textContent = "Connected to serial port.";
	}
	else
	{
		statusDiv.textContent = "";
	}
	setActiveButtons();	
});

flashButton.addEventListener("click", async () => 
{
	started = true;
	setActiveButtons();
	detected = false;
	flashing = false;
	block = 0;
	statusDiv.textContent = "Turn off radio, press PTT(H3) or Flashlight(H8), turn on radio with button still held.";
	try
	{
		await byteReader();
	}
	catch(error)
	{
		statusDiv.textContent = `Flashing failed: ${error.message}`;
		started = false;
	}
	setActiveButtons();
});

abortButton.addEventListener("click", async () => 
{
	started = false;
	closeSerial();
	setActiveButtons();
});

async function byteProcessor(byt)
{
	if(detected && !flashing) 
	{
		clearTimeout(timeoutId);
		timeoutId = setTimeout( () => 
		{
			flashing = true;
			byteProcessor(0xA3);
		}, 400);
	}		
	switch(byt)
	{
		case 0xA5: // handshake byte
			if(!detected) 
			{
				detected = true;
				await writer.write(initSequence);
			}
			else
			if(flashing) 
			{
				throw new Error("Bad response from radio during handshake.");
			}				
			break;
		case 0xA3: // block ack byte
			if(flashing) 
			{
				if(block > lastBlock) 
				{
					statusDiv.textContent = "Flashing complete.";
					started = false;
					break;
				}
				statusDiv.textContent = `Flashing block: ${block} / ${lastBlock}`;
				const packet = new Uint8Array(36);
				packet[0] = block == lastBlock ? 0xA2 : 0xA1;
				packet[1] = (block >> 8) & 0xff;
				packet[2] = block & 0xff;
				const startIndex = block * 32;
				packet.set(firmware.subarray(startIndex, startIndex + 32), 4);
				packet[3] = 0;
				for(d = 4; d < 36; d++)
				{
					packet[3] += packet[d];
				}
				await writer.write(packet);
				block++;
			} 
			else
			{
				if(detected)
				{
					throw new Error("Bad ACK from radio.");
				}
			}
			break;
		default: // anything else
			if(detected)
			{
				throw new Error("Bad data from radio.");
			}				
			break;
	}
}

async function byteReader()
{
	while(started)
	{
		const { value, done } = await reader.read();
        if (done || !value) 
		{
			throw new Error("Serial connection lost.");
		}
		for(let b of value) 
		{
			await byteProcessor(b);
		}		
	}		
}