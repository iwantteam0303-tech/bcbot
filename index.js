module.exports = function(BOT_TOKEN) {
    const { 
        Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
        EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes, ChannelType 
    } = require('discord.js');
    
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    let ownerId = null;
    let targetChannelId = null;
    let activeThreadId = null; 
    let ptyProcess = null;
    let outputBuffer = '';
    let sendTimer = null;

    const DB_FILE = './db.json';
    let db = { tickets: {}, shopChannelId: null, saveChannelId: null, shopItems: {}, targetChannelId: null, autoSetupSequence: [] };
    const activeSessions = {};
    const sequenceQueue = [];
    let currentTask = null; 
    let isExecuting = false;
    let queueMessageId = null; 

    // 가장 안전한 세이브 모니터링 폴더
    const WATCH_DIR = path.join(process.env.HOME, 'bcsave');

    function loadDB() {
        if (fs.existsSync(DB_FILE)) {
            const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            db = { ...db, ...raw }; 
        }
        if (!db.shopItems) db.shopItems = {};
        if (!db.autoSetupSequence) db.autoSetupSequence = [];
    }
    
    function saveDB() {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    }
    loadDB();

    const stripAnsi = (str) => str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

    function initTerminal() {
        if (ptyProcess) ptyProcess.kill();
        
        ptyProcess = spawn('script', ['-q', '-c', 'bash', '/dev/null'], { 
            cwd: process.env.HOME, 
            env: { ...process.env, TERM: 'xterm-256color' } 
        });

        const handleData = (data) => {
            outputBuffer += stripAnsi(data.toString());
            if (sendTimer) clearTimeout(sendTimer);
            
            sendTimer = setTimeout(async () => {
                if (!outputBuffer.trim() || !targetChannelId) return;
                
                const outChannelId = activeThreadId ? activeThreadId : targetChannelId;
                const channel = client.channels.cache.get(outChannelId);
                
                if (channel) {
                    const maxLen = 1950;
                    const lines = outputBuffer.split('\n');
                    let chunk = '';
                    for (const line of lines) {
                        if (line.length > maxLen) {
                            if (chunk) { await channel.send(`\`\`\`text\n${chunk}\`\`\``); chunk = ''; }
                            for (let i = 0; i < line.length; i += maxLen) await channel.send(`\`\`\`text\n${line.slice(i, i + maxLen)}\`\`\``);
                            continue;
                        }
                        if (chunk.length + line.length + 1 > maxLen) {
                            await channel.send(`\`\`\`text\n${chunk}\`\`\``);
                            chunk = line + '\n';
                        } else chunk += line + '\n';
                    }
                    if (chunk.trim()) await channel.send(`\`\`\`text\n${chunk}\`\`\``);
                }
                outputBuffer = '';
                sendTimer = null;
            }, 800);
        };

        ptyProcess.stdout.on('data', handleData);
        ptyProcess.stderr.on('data', handleData);
    }

    function waitForTerminalReady() {
        return new Promise((resolve) => {
            let waitBuffer = '';
            let idleTimer = null;
            const finish = () => {
                ptyProcess.stdout.removeListener('data', onData);
                ptyProcess.stderr.removeListener('data', onData);
                resolve(waitBuffer);
            };
            const onData = (data) => {
                waitBuffer += stripAnsi(data.toString());
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => { finish(); }, 12000); 
            };
            ptyProcess.stdout.on('data', onData);
            ptyProcess.stderr.on('data', onData);
            idleTimer = setTimeout(() => { finish(); }, 12000);
        });
    }

    function buildAST(flatSeq) {
        const root = { type: 'root', children: [] };
        const stack = [root];

        const expandedSeq = [];
        for (const rawLine of flatSeq) {
            const parts = String(rawLine).split(/\\n|\n/);
            for (const p of parts) {
                if (p.trim() !== '') expandedSeq.push(p.trim());
            }
        }

        for (let i = 0; i < expandedSeq.length; i++) {
            let line = expandedSeq[i];
            const currentBlock = stack[stack.length - 1];

            const openMatch = line.match(/^([\s\S]*?)_include_([\s\S]*?)\($/);
            if (openMatch) {
                const node = { type: 'if', cmd: openMatch[1].trim(), key: openMatch[2].trim(), children: [] };
                currentBlock.children.push(node);
                stack.push(node);
                continue;
            }

            let closeCount = 0;
            let strippedLine = line;
            const closeMatch = strippedLine.match(/(\)+)$/);

            if (closeMatch) {
                const trailingParens = closeMatch[1].length;
                const maxClosable = stack.length - 1;
                closeCount = Math.min(trailingParens, maxClosable);

                if (closeCount > 0) {
                    strippedLine = strippedLine.substring(0, strippedLine.length - closeCount).trim();
                }
            }

            if (strippedLine.length > 0) {
                currentBlock.children.push({ type: 'cmd', cmd: strippedLine });
            }

            for (let c = 0; c < closeCount; c++) {
                stack.pop();
            }
        }

        if (stack.length > 1) {
            throw new Error(`여는 괄호 '(' 에 매칭되는 닫는 괄호 ')' 가 부족합니다. (현재 ${stack.length - 1}개 안 닫힘)`);
        }

        return root.children;
    }

    async function executeAST(nodes, answers, user, logChannel, execState) {
        for (const node of nodes) {
            if (node.type === 'cmd') {
                let actualCmd = node.cmd;
                for (const [key, val] of Object.entries(answers)) {
                    actualCmd = actualCmd.replace(new RegExp(`save_${key}`, 'g'), val);
                }

                if (logChannel) await logChannel.send(`> <@${user.id}>: \n\`\`\`text\n${actualCmd}\n\`\`\``);
                ptyProcess.stdin.write(actualCmd + '\n');
                execState.finalOutput = await waitForTerminalReady();

            } else if (node.type === 'if') {
                let actualCmd = node.cmd;
                let actualKey = node.key;
                
                for (const [key, val] of Object.entries(answers)) {
                    actualCmd = actualCmd.replace(new RegExp(`save_${key}`, 'g'), val);
                    actualKey = actualKey.replace(new RegExp(`save_${key}`, 'g'), val);
                }

                if (logChannel) await logChannel.send(`> <@${user.id}>: \n\`\`\`text\n${actualCmd}\n\`\`\` 🔍(조건검사: \`${actualKey}\` 포함 대기)`);
                ptyProcess.stdin.write(actualCmd + '\n');
                execState.finalOutput = await waitForTerminalReady();

                if (execState.finalOutput.includes(actualKey)) {
                    if (logChannel) await logChannel.send(`✅ **[조건 만족]** \`${actualKey}\` 문자열이 발견되어 내부 시퀀스를 실행합니다.`);
                    await executeAST(node.children, answers, user, logChannel, execState);
                } else {
                    if (logChannel) await logChannel.send(`⏭️ **[조건 불만족]** \`${actualKey}\` 문자열이 없어 내부 블록을 건너뜁니다.`);
                }
            }
        }
    }

    async function updateQueueEmbed() {
        if (!db.shopChannelId || !queueMessageId) return;
        const channel = client.channels.cache.get(db.shopChannelId);
        if (!channel) return;
        
        const embed = new EmbedBuilder().setTitle('⏳ 현재 시스템 대기열').setColor(0xFFA500);
        if (!currentTask && sequenceQueue.length === 0) {
            embed.setDescription('```\n현재 대기 중인 작업이 없습니다.\n```');
        } else {
            let desc = ''; let count = 1;
            if (currentTask) { desc += `**${count}.** <@${currentTask.userId}> - 작업: ${currentTask.itemTitle} \`[🔄 진행중]\`\n`; count++; }
            for (const task of sequenceQueue) { desc += `**${count}.** <@${task.userId}> - 작업: ${task.itemTitle} \`[⏳ 대기중]\`\n`; count++; }
            embed.setDescription(desc);
        }

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('check_balance').setLabel('💳 내 코인(티켓) 확인').setStyle(ButtonStyle.Secondary)
        );

        try {
            const msg = await channel.messages.fetch(queueMessageId);
            await msg.edit({ embeds: [embed], components: [actionRow] });
        } catch (e) { queueMessageId = null; }
    }

    async function renderShop(channel) {
        const fetched = await channel.messages.fetch({ limit: 50 });
        await channel.bulkDelete(fetched).catch(() => {});
        if (Object.keys(db.shopItems).length === 0) return channel.send("🛒 현재 상점에 등록된 상품이 없습니다.");
        
        for (const [itemId, item] of Object.entries(db.shopItems)) {
            const embed = new EmbedBuilder().setTitle(`🎁 ${item.title}`).setDescription(`${item.description}\n\n**가격:** 🎟️ 티켓 ${item.price}개`).setColor(0x00FF00).setFooter({ text: `상품 ID: ${itemId}` });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`buy_${itemId}`).setLabel('구매하기').setStyle(ButtonStyle.Primary).setEmoji('🛒'));
            await channel.send({ embeds: [embed], components: [row] });
        }
        
        const qEmbed = new EmbedBuilder().setTitle('⏳ 현재 시스템 대기열').setDescription('```\n데이터 동기화 중...\n```').setColor(0xFFA500);
        const qRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('check_balance').setLabel('💳 내 코인(티켓) 확인').setStyle(ButtonStyle.Secondary)
        );
        const qMsg = await channel.send({ embeds: [qEmbed], components: [qRow] });
        queueMessageId = qMsg.id;
        await updateQueueEmbed();
    }

    async function processQueue() {
        if (isExecuting || sequenceQueue.length === 0) return;
        isExecuting = true;
        currentTask = sequenceQueue.shift();
        await updateQueueEmbed(); 
        
        const { interaction, userId, itemTitle, answers, sequenceAST } = currentTask;
        const user = interaction.user;
        const termChannel = client.channels.cache.get(targetChannelId);

        let thread = null;
        if (termChannel) {
            thread = await termChannel.threads.create({ 
                name: `[진행중] 👤${user.username}님의 작업`, 
                autoArchiveDuration: 1440, 
                type: ChannelType.PrivateThread 
            }).catch(() => null); 
            
            if (thread) { 
                activeThreadId = thread.id; 
                await thread.send(`🛠️ **[작업 시작]** <@${user.id}> 님의 **${itemTitle}** 작업을 시작합니다.`); 
            }
        }

        const logChannel = thread || termChannel;
        const execState = { finalOutput: '' };
        let isSuccess = true;

        try {
            ptyProcess.stdin.write('\x03'); ptyProcess.stdin.write('cd ~\n');
            await waitForTerminalReady();
            await executeAST(sequenceAST, answers, user, logChannel, execState);
        } catch (err) {
            if (logChannel) await logChannel.send(`❌ **[시스템 에러]** ${err.message}`);
            isSuccess = false;
        }

        if (isSuccess) {
            const tCodeMatch = execState.finalOutput.match(/Transfer Code:\s*([a-zA-Z0-9]+)/i);
            const cCodeMatch = execState.finalOutput.match(/Confirmation Code:\s*([a-zA-Z0-9]+)/i);
            if (tCodeMatch && cCodeMatch) {
                const resultEmbed = new EmbedBuilder().setTitle('✅ 작업 완료 안내').setDescription(`<@${user.id}>님의 계정 작업이 완료되었습니다.`).addFields({ name: 'Transfer Code', value: `\`${tCodeMatch[1]}\`` }, { name: 'Confirmation Code', value: `\`${cCodeMatch[1]}\`` }).setColor(0x00FF00);
                if (logChannel) await logChannel.send({ content: `✅ **[결과 발급 완료]** <@${user.id}>`, embeds: [resultEmbed] });
                try { await interaction.followUp({ content: `<@${user.id}> 작업 완료!`, embeds: [resultEmbed], ephemeral: true }); } catch (e) {}
                await user.send({ embeds: [resultEmbed] }).catch(() => { if (logChannel) logChannel.send(`⚠️ <@${user.id}> 님에게 DM을 보낼 수 없습니다.`); });
            } else {
                if (logChannel) await logChannel.send(`❌ **[추출 실패]** 코드를 추출하지 못했습니다.`);
                try { await interaction.followUp({ content: '⚠️ 작업 완료(코드 추출 실패)', ephemeral: true }); } catch (e) {}
            }
        }
        
        if (thread) { 
            await thread.setName(`[완료] 👤${user.username}님의 작업`); 
            const closeRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_thread').setLabel('🔒 쓰레드 닫기 (확인 완료)').setStyle(ButtonStyle.Danger)
            );
            await thread.send({ content: '✅ 작업 로그가 모두 기록되었습니다. 내역을 확인하신 후 아래 버튼을 눌러 스레드를 정리하세요.', components: [closeRow] });
        }
        
        activeThreadId = null; currentTask = null; isExecuting = false;
        await updateQueueEmbed();
        if (sequenceQueue.length > 0) setTimeout(processQueue, 3000); 
    }

    // 💡 [핵심] 3초마다 ~/bcsave 폴더를 스캔해서 새 파일이 있으면 업로드하고 지우는 파일 와쳐
    function startFileWatcher() {
        if (!fs.existsSync(WATCH_DIR)) {
            fs.mkdirSync(WATCH_DIR, { recursive: true });
        }

        setInterval(async () => {
            if (!db.saveChannelId) return;
            const channel = client.channels.cache.get(db.saveChannelId);
            if (!channel) return;

            try {
                const files = fs.readdirSync(WATCH_DIR);
                for (const file of files) {
                    const filePath = path.join(WATCH_DIR, file);
                    const stats = fs.statSync(filePath);
                    
                    if (stats.isFile()) {
                        await channel.send({
                            content: `📦 **[세이브 추출 완료]** 봇 내부에서 새 파일이 감지되었습니다: \`${file}\``,
                            files: [filePath]
                        }).catch(() => {});
                        
                        // 업로드 완료 후 디스크 용량 관리를 위해 파일 삭제
                        fs.unlinkSync(filePath);
                    }
                }
            } catch (e) {
                // 권한 등 기타 에러 무시
            }
        }, 3000);
    }

    client.once('ready', async () => {
        console.log(`봇 온라인: ${client.user.tag}`);
        const app = await client.application.fetch();
        ownerId = app.owner.ownerId ? app.owner.ownerId : app.owner.id;

        startFileWatcher(); // 파일 와쳐 시작

        const commands = [
            { name: '터미널설정', description: '이 채널을 터미널로 설정합니다. (초기화 됨)' },
            { name: '세이브방설정', description: '추출된 세이브 파일을 자동으로 업로드할 채널을 설정합니다.' }, // 💡 새 명령어 추가
            { name: '티켓수설정', description: '유저의 티켓 수를 지정합니다.', options: [{type: 6, name: '유저', description: '대상 유저', required: true}, {type: 4, name: '수량', description: '티켓 수량', required: true}] },
            { name: '티켓주기', description: '유저에게 티켓을 지급합니다.', options: [{type: 6, name: '유저', description: '대상 유저', required: true}, {type: 4, name: '수량', description: '추가할 수량', required: true}] },
            { name: '확인', description: '해당 유저의 데이터(보유 코인 등)를 확인합니다.', options: [{type: 6, name: '유저', description: '조회할 유저', required: true}] },
            { name: '상점방설정', description: '이 채널을 상점방으로 설정합니다.' },
            { name: '상점추가', description: '상점에 JSON 상품을 추가합니다.', options: [
                {type: 3, name: '상품id', description: '고유 ID', required: true},
                {type: 11, name: 'json파일', description: 'JSON 업로드', required: true},
                {type: 3, name: '상품제목', description: '제목', required: true},
                {type: 3, name: '상품설명', description: '설명', required: true},
                {type: 4, name: '가격', description: '가격', required: true}
            ]},
            { name: '상점제거', description: '상점 상품 제거', options: [{type: 3, name: '상품id', description: '고유 ID', required: true}] },
            { name: '업데이트', description: '최신 코드를 불러오기 위해 봇을 재부팅합니다.' },
            { name: '자동세팅', description: '부팅 시 자동 실행할 시퀀스 JSON을 등록합니다.', options: [{type: 11, name: 'json파일', description: 'Sequence 배열 JSON', required: true}] },
            { name: 'db추출', description: '현재 데이터베이스(db.json) 파일을 다운로드합니다.' },
            { name: 'db입력', description: '데이터베이스(db.json) 파일을 업로드하여 덮어씁니다.', options: [{type: 11, name: '파일', description: '업로드할 db.json 파일', required: true}] }
        ];

        const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        if (db.shopChannelId) await updateQueueEmbed(); 

        if (db.targetChannelId) {
            targetChannelId = db.targetChannelId;
            const termChannel = client.channels.cache.get(targetChannelId);
            initTerminal();

            if (termChannel) {
                await termChannel.send(`👋 <@${ownerId}>님, 시스템이 성공적으로 재부팅되었습니다!`);
                if (db.autoSetupSequence && db.autoSetupSequence.length > 0) {
                    await termChannel.send(`🛠️ **[자동 세팅]** 등록된 초기 시퀀스를 실행합니다...`);
                    const execState = { finalOutput: '' };
                    try {
                        const ast = buildAST(db.autoSetupSequence);
                        await waitForTerminalReady();
                        await executeAST(ast, {}, { id: ownerId, username: '자동세팅' }, termChannel, execState);
                        await termChannel.send(`✅ **[자동 세팅 완료]** 터미널이 유휴 상태로 전환되었습니다.`);
                    } catch (e) {
                        await termChannel.send(`❌ **[자동 세팅 실패]** 시퀀스 오류: ${e.message}`);
                    }
                }
            }
        }
    });

    client.on('interactionCreate', async (interaction) => {
        if (interaction.isChatInputCommand()) {
            if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ 권한이 없습니다.', ephemeral: true });
            const cmd = interaction.commandName;

            if (cmd === '터미널설정') {
                targetChannelId = interaction.channel.id; db.targetChannelId = targetChannelId; saveDB(); initTerminal();
                return interaction.reply('✅ **채널 설정 및 터미널 초기화 완료.**');
            }
            // 💡 새 명령어 처리 구문
            if (cmd === '세이브방설정') {
                db.saveChannelId = interaction.channel.id; saveDB();
                return interaction.reply('✅ **현재 채널이 세이브 파일 자동 업로드 방으로 설정되었습니다.** (`~/bcsave` 폴더 감시 중)');
            }
            if (cmd === '업데이트') {
                await interaction.reply('🔄 **시스템을 재시작합니다.** 잠시 후 최신 코드로 부팅됩니다.');
                setTimeout(() => { process.exit(0); }, 1000); return;
            }
            if (cmd === '자동세팅') {
                const file = interaction.options.getAttachment('json파일');
                if (!file.name.endsWith('.json')) return interaction.reply({ content: '❌ JSON 파일만 가능합니다.', ephemeral: true });
                try {
                    const response = await fetch(file.url); const jsonData = await response.json();
                    if (!jsonData.Sequence) return interaction.reply({ content: '❌ Sequence 배열이 없습니다.', ephemeral: true });
                    buildAST(jsonData.Sequence);
                    db.autoSetupSequence = jsonData.Sequence; saveDB();
                    return interaction.reply('✅ **자동 세팅 시퀀스 등록 완료.**');
                } catch (e) {
                    return interaction.reply({ content: `❌ 문법 파싱 에러: ${e.message}`, ephemeral: true });
                }
            }
            if (cmd === '상점방설정') {
                db.shopChannelId = interaction.channel.id; saveDB();
                await interaction.reply({ content: '✅ 상점 렌더링 중...', ephemeral: true }); await renderShop(interaction.channel); return;
            }
            if (cmd === '상점추가') {
                const id = interaction.options.getString('상품id'); const file = interaction.options.getAttachment('json파일');
                const title = interaction.options.getString('상품제목'); const desc = interaction.options.getString('상품설명'); const price = interaction.options.getInteger('가격');
                try {
                    const response = await fetch(file.url); const jsonData = await response.json();
                    const ast = buildAST(jsonData.Sequence);
                    db.shopItems[id] = { title, description: desc, price, options: jsonData.Options, sequenceAST: ast }; saveDB();
                    await interaction.reply({ content: `✅ 추가 완료!`, ephemeral: true });
                    if (db.shopChannelId) { const ch = client.channels.cache.get(db.shopChannelId); if (ch) await renderShop(ch); }
                } catch (e) { return interaction.reply({ content: `❌ 에러: ${e.message}`, ephemeral: true }); }
            }
            if (cmd === '티켓수설정' || cmd === '티켓주기') {
                const user = interaction.options.getUser('유저'); const amt = interaction.options.getInteger('수량');
                if (cmd === '티켓수설정') db.tickets[user.id] = amt; else db.tickets[user.id] = (db.tickets[user.id] || 0) + amt;
                saveDB(); return interaction.reply(`✅ ${user.username}님의 티켓: **${db.tickets[user.id]}개**`);
            }
            if (cmd === '상점제거') {
                const id = interaction.options.getString('상품id'); delete db.shopItems[id]; saveDB();
                await interaction.reply({ content: '✅ 제거 완료!', ephemeral: true });
                if (db.shopChannelId) { const ch = client.channels.cache.get(db.shopChannelId); if (ch) await renderShop(ch); }
            }
            if (cmd === '확인') {
                const user = interaction.options.getUser('유저');
                const tickets = db.tickets[user.id] || 0;
                const embed = new EmbedBuilder()
                    .setTitle(`📊 ${user.username}님의 데이터 조회`)
                    .addFields({ name: '보유 코인(티켓)', value: `**${tickets}개**` })
                    .setColor(0x3498DB);
                return interaction.reply({ embeds: [embed] });
            }
            
            if (cmd === 'db추출') {
                if (!fs.existsSync(DB_FILE)) {
                    return interaction.reply({ content: '❌ 현재 저장된 DB 파일이 존재하지 않습니다.', ephemeral: true });
                }
                return interaction.reply({ 
                    content: '📦 현재 시스템에 저장된 `db.json` 파일입니다.', 
                    files: [DB_FILE], 
                    ephemeral: true 
                });
            }

            if (cmd === 'db입력') {
                const file = interaction.options.getAttachment('파일');
                if (!file.name.endsWith('.json')) return interaction.reply({ content: '❌ JSON 파일만 업로드 가능합니다.', ephemeral: true });

                try {
                    const response = await fetch(file.url);
                    const jsonData = await response.json();

                    if (typeof jsonData !== 'object') {
                        return interaction.reply({ content: '❌ 올바른 DB 형식이 아닙니다.', ephemeral: true });
                    }

                    db = { ...db, ...jsonData };
                    saveDB();

                    await interaction.reply({ content: '✅ 데이터베이스 파일이 성공적으로 적용되었습니다. 상점 및 세팅이 복원되었습니다.', ephemeral: true });
                    
                    if (db.shopChannelId) {
                        const shopChannel = client.channels.cache.get(db.shopChannelId);
                        if (shopChannel) await renderShop(shopChannel);
                    }
                    return;

                } catch (e) {
                    return interaction.reply({ content: `❌ 파일 파싱 에러: ${e.message}`, ephemeral: true });
                }
            }
        }

        if (interaction.isButton() && interaction.customId === 'check_balance') {
            const userTickets = db.tickets[interaction.user.id] || 0;
            return interaction.reply({ 
                content: `💳 **${interaction.user.username}**님의 현재 보유 코인(티켓)은 **${userTickets}개** 입니다.`, 
                ephemeral: true 
            });
        }

        if (interaction.isButton() && interaction.customId === 'close_thread') {
            if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ 권한이 없습니다.', ephemeral: true });
            await interaction.reply({ content: '🔒 확인 완료. 쓰레드를 보관 처리합니다.' });
            if (interaction.channel.isThread()) {
                await interaction.channel.setArchived(true);
            }
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
            const itemId = interaction.customId.replace('buy_', ''); const item = db.shopItems[itemId];
            const userTickets = db.tickets[interaction.user.id] || 0;
            if (userTickets < item.price) return interaction.reply({ content: `❌ 코인(티켓)이 부족합니다.`, ephemeral: true });
            activeSessions[interaction.user.id] = { itemId, currentChunk: 0, answers: {} };
            await showModalChunk(interaction, interaction.user.id);
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_form_')) {
            const session = activeSessions[interaction.user.id];
            if (!session) return interaction.reply({ content: '❌ 시간 초과', ephemeral: true });
            const item = db.shopItems[session.itemId];
            const chunkStart = session.currentChunk * 5; const currentOptions = item.options.slice(chunkStart, chunkStart + 5);
            for (const opt of currentOptions) {
                const rawVal = interaction.fields.getTextInputValue(`input_${opt}`);
                if (!/^[a-zA-Z0-9]+$/.test(rawVal)) { delete activeSessions[interaction.user.id]; return interaction.reply({ content: `❌ 영문/숫자만 가능`, ephemeral: true }); }
                session.answers[opt] = rawVal;
            }
            if ((session.currentChunk + 1) * 5 < item.options.length) {
                session.currentChunk += 1; await showModalChunk(interaction, interaction.user.id);
            } else {
                db.tickets[interaction.user.id] -= item.price; saveDB();
                sequenceQueue.push({ interaction, userId: interaction.user.id, itemTitle: item.title, answers: session.answers, sequenceAST: item.sequenceAST });
                await updateQueueEmbed();
                await interaction.reply({ content: `✅ 대기열에 등록되었습니다.`, ephemeral: true });
                delete activeSessions[interaction.user.id]; processQueue();
            }
        }
    });

    async function showModalChunk(interaction, userId) {
        const session = activeSessions[userId]; const item = db.shopItems[session.itemId];
        const chunkStart = session.currentChunk * 5; const currentOptions = item.options.slice(chunkStart, chunkStart + 5);
        const modal = new ModalBuilder().setCustomId(`modal_form_${session.itemId}_${session.currentChunk}`).setTitle(`📝 상품 정보 입력`);
        for (const opt of currentOptions) {
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(`input_${opt}`).setLabel(opt).setStyle(TextInputStyle.Short).setRequired(true)));
        }
        await interaction.showModal(modal);
    }

    client.on('messageCreate', (message) => {
        if (message.author.bot) return;
        
        if ((message.channel.id === targetChannelId || (activeThreadId && message.channel.id === activeThreadId)) && message.author.id === ownerId) {
            if (ptyProcess) ptyProcess.stdin.write(message.content + '\n');
        }
    });

    client.login(BOT_TOKEN);
};
