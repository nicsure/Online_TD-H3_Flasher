let port = null;
let writer = null;
let reader = null;
let codeplug = null;
let started = false;
let synced = false;
let syncCount = 0;
let state = 0;
let ack = false;
let blkcount = 0;
let blkcs = 0;
let blkbuffer = new Uint8Array(32);

const codeplugFileInput = document.getElementById("codeplugFile");
const readButton = document.getElementById("readButton");
const writeButton = document.getElementById("writeButton");
const statusDiv = document.getElementById("status");
const connectButton = document.getElementById("connectButton");
const abortButton = document.getElementById("abortButton");
const saveButton = document.getElementById("saveButton");
const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
document.body.style.backgroundColor = isDarkMode ? 'black' : 'white';
document.body.style.color = isDarkMode ? 'white' : 'black';
document.body.style.fontFamily = 'sans-serif';

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

async function openSerial(baud)
{
	if(port != null)
	{
		try
		{
			await port.open({ baudRate: baud });
			writer = port.writable.getWriter();
			reader = port.readable.getReader();
		}
		catch (error)
		{
			statusDiv.textContent = `Serial port error: ${error.message}`;
            port = null;
            writer = null;
            reader = null;
		}
	}
}

function setActiveButtons()
{
    readButton.disabled = (started || port==null);
    writeButton.disabled = (started || port==null || codeplug==null);
    saveButton.disabled = (started || codeplug==null);
    abortButton.disabled = port==null;
    connectButton.disabled = port!=null;
    codeplugFileInput.disabled = started;
}

function sleep(ms)
{
    return new Promise(resolve => setTimeout(resolve, ms));
}

function initPacket(pktLength, fill)
{
    const tmppacket = new Uint8Array(pktLength);
    for(i = 0; i<pktLength; i++)
    {
        tmppacket[i] = fill;
    }
    return tmppacket;
}    

async function syncRadio()
{
    synced = false;
    syncCount = 0;
    const syncpacket = initPacket(32, 1);
    await writer.write(syncpacket);
    for(i=0; i<100; i++)
    {
        if(synced)
            break;
        await sleep(10);
    }
    await sleep(100);
}

async function byteReader()
{
	while(port!=null)
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

async function byteProcessor(byt)
{
    switch(state)
    {
        case 0: // idle
            switch(byt)
            {
                case 1: // ping
                    syncCount++;
                    if(syncCount>16)
                    {
                        if(!synced)
                            statusDiv.textContent = "Radio Found";
                        synced=true;
                    }
                    break;
                case 0x30: // read block
                    state = byt;
                    blkcount = 0;
                    blkcs = 0;
                    break;
                case 0x31: // write block ack
                    ack = true;
                    break;
            }
            break;
        case 0x30: // read block data
            blkcs+=byt;
            blkbuffer[blkcount++] = byt;
            if(blkcount>=32)
                state = 0x130; // checksum
            break;
        case 0x130: // checksum
            if((blkcs&0xff) == byt)
                ack=true;
            state = 0; // idle
            break;

    }
}

connectButton.addEventListener("click", async () => 
{
    await selectSerialPort();
    await openSerial(38400);
    if(port)
    {
        statusDiv.textContent = "Connected to serial port.";
    }
    else
    {
        statusDiv.textContent = "";
    }
    setActiveButtons();
    if(port)
    {
        try
        {
            await byteReader();
        }
        catch(error)
        {
            statusDiv.textContent = `${error.message}`;
        }
    }
    port=null;
    reader=null;
    writer=null;
    setActiveButtons();
});

codeplugFileInput.addEventListener("change", async (event) => 
{
    try
    {
        codeplug = null;
        if(event.target.files[0])
        {
            const fileData = await event.target.files[0].arrayBuffer();
            const fileBytes = new Uint8Array(fileData);
            const fileLength = fileBytes.length
            if(fileLength != 8192)
            {
                throw new Error("Incorrect file size "+fileLength);
            }
            codeplug = new Uint8Array(8192);
            codeplug.set(fileBytes);
            statusDiv.textContent = "Codeplug file loaded.";
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

writeButton.addEventListener("click", async () => 
{
    state = 0;
    started = true;
	setActiveButtons();
    statusDiv.textContent = "Finding Radio.";
    await syncRadio();
    if(synced)
    {
        const blockput = new Uint8Array(35);
        blockput[0]=0x31;
        for(block = 0; block<256; block++)
        {
            blockput[1]=block;
            blockput[34]=0;
            for(i = 0; i<32; i++)
            {
                const b = codeplug[(block*32)+i];
                blockput[i+2] = b;
                blockput[34] += b;
            }
            ack = false;
            await writer.write(blockput);        
            timeout = 0;
            while(!ack && timeout++<100)
            {
                await sleep(10);
            }
            if(!ack)
            {
                statusDiv.textContent = "Radio Communication Timeout";
                started=false;
                setActiveButtons();
                return;
            }
            statusDiv.textContent = `Writing Block ${block+1}/256`; 
        }
        const resetreq = new Uint8Array(1);
        resetreq[0]=0x49;
        await writer.write(resetreq); 
        started=false;
        statusDiv.textContent = "Codeplug Write Complete";       
    }
    else
    {
        statusDiv.textContent = "Cannot Find Radio.";
        started = false;
    }
    setActiveButtons();    
});

readButton.addEventListener("click", async () => 
{
    state = 0;
	started = true;
	setActiveButtons();
    statusDiv.textContent = "Finding Radio.";
    await syncRadio();
    if(synced)
    {
        const tempcp = new Uint8Array(8192);
        const blockreq = new Uint8Array(2);
        blockreq[0]=0x30;
        for(block = 0; block<256; block++)
        {
            blockreq[1]=block;
            ack = false;
            await writer.write(blockreq);
            timeout = 0;
            while(!ack && timeout++<100)
            {
                await sleep(10);
            }
            if(!ack)
            {
                statusDiv.textContent = "Radio Communication Timeout";
                started=false;
                setActiveButtons();
                return;
            }
            statusDiv.textContent = `Reading Block ${block+1}/256`;
            tempcp.set(blkbuffer, block*32);
        }
        started=false;
        statusDiv.textContent = "Codeplug Read Complete";
        codeplug=tempcp;
    }
    else
    {
        statusDiv.textContent = "Cannot Find Radio.";
        started = false;
    }
    setActiveButtons();
});

abortButton.addEventListener("click", async () => 
{
    location.reload();
});

saveButton.addEventListener("click", async () => 
{
    const blob = new Blob([codeplug], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "codeplug.nfw";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});


/*
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
*/