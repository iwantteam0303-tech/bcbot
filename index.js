module.exports = function(BOT_TOKEN) {
    const { 
        Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
        EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes, ChannelType 
    } = require('discord.js');
    const pty = require('node-pty');
    const fs = require('fs');

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
    let db = { tickets: {}, shopChannelId: null, shopItems: {}, targetChannelId: null, autoSetupSequence: [] };
    const activeSessions = {};
    const sequenceQueue = [];
    let currentTask = null; 
    let isExecuting = false;
    let queueMessageId = null; 

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
        ptyProcess = pty.spawn('bash', [], { name: 'xterm-color', cols: 80, rows: 30, cwd: process.env.HOME, env: process.env });

        ptyProcess.on('data', (data) => {
            outputBuffer += stripAnsi(data);
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
        });
    }

    function waitForTerminalReady() {
        return new Promise((resolve) => {
            let waitBuffer = '';
            let idleTimer = null;
            const finish = () => {
                ptyProcess.removeListener('data', onData);
                resolve(waitBuffer);
            };
            const onData = (data) => {
                waitBuffer += stripAnsi(data);
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => { finish(); }, 5000); 
            };
            ptyProcess.on('data', onData);
            idleTimer = setTimeout(() => { finish(); }, 5000);
        });
    }

    // ==========================================
    // 🧠 시퀀스 문법 파서 (AST 트리 빌더)
    // ==========================================
    function buildAST(flatSeq) {
        const root = { type: 'root', children: [] };
        const stack = [root];

        for (let i = 0; i < flatSeq.length; i++) {
            let line = flatSeq[i];
            const currentBlock = stack[stack.length - 1];

            // 조건부 블록 열기: 명령어_include_키워드(
            const openMatch = line.match(/^(.*)_include_(.*?)\($/);
            if (openMatch) {
                const node = { type: 'if', cmd: openMatch[1], key: openMatch[2], children: [] };
                currentBlock.children.push(node);
                stack.push(node);
                continue;
            }

            // 조건부 블록 닫기: 줄 끝에 있는 ) 의 개수를 파악하여 블록을 닫음
            let closeCount = 0;
            let strippedLine = line;
            const closeMatch = strippedLine.match(/(\)+)$/);

            if (closeMatch) {
                const trailingParens = closeMatch[1].length;
                // 열려있는 블록 수만큼만 ) 를 소진함 (root는 닫을 수 없음)
                const maxClosable = stack.length - 1;
                closeCount = Math.min(trailingParens, maxClosable);

                if (closeCount > 0) {
                    strippedLine = strippedLine.substring(0, strippedLine.length - closeCount).trim();
                }
            }

            // 명령어가 남아있다면 추가 (ex: "kill apple)", ")" 단독 줄 모두 호환)
            if (strippedLine.length > 0) {
                currentBlock.children.push({ type: 'cmd', cmd: strippedLine });
            }

            // 닫힌 괄호 수만큼 스택에서 제거 (상위 블록으로 이동)
            for (let c = 0; c < closeCount; c++) {
                stack.pop();
            }
        }

        // 파싱이 끝났는데 스택이 1보다 크면(root가 아니면) 괄호가 안 닫힌 것
        if (stack.length > 1) {
            throw new Error("여는 괄호 '(' 에 매칭되는 닫는 괄호 ')' 가 부족합니다.");
        }

        return root.children;
    }

    // ==========================================
    // ⚙️ AST 트리 실행기 (재귀 구조)
    // ==========================================
    async function executeAST(nodes, answers, user, logChannel, execState) {
        for (const node of nodes) {
            if (node.type === 'cmd') {
                let actualCmd = node.cmd;
                for (const [key, val] of Object.entries(answers)) {
                    actualCmd = actualCmd.replace(new RegExp(`save_${key}`, 'g'), val);
                }

                if (logChannel) await logChannel.send(`> <@${user.id}>: \`${actualCmd}\``);
                ptyProcess.write(actualCmd + '\r');
                execState.finalOutput = await waitForTerminalReady();

            } else if (node.type === 'if') {
                let actualCmd = node.cmd;
                let actualKey = node.key;
                
                // 명령어와 키워드 모두 모달 응답(save_xxx)으로 치환 가능
                for (const [key, val] of Object.entries(answers)) {
                    actualCmd = actualCmd.replace(new RegExp(`save_${key}`, 'g'), val);
                    actualKey = actualKey.replace(new RegExp(`save_${key}`, 'g'), val);
                }

                if (logChannel) await logChannel.send(`> <@${user.id}>: \`${actualCmd}\` 🔍(조건검사: \`${actualKey}\` 포함 대기)`);
                ptyProcess.write(actualCmd + '\r');
                execState.finalOutput = await waitForTerminalReady();

                // 실행 결과에 키워드가 포함되어 있다면 블록 내부를 재귀적으로 실행
                if (execState.finalOutput.includes(actualKey)) {
                    if (logChannel) await logChannel.send(`✅ **[조건 만족]** \`${actualKey}\` 문자열이 발견되어 내부 시퀀스를 실행합니다.`);
                    await executeAST(node.children, answers, user, logChannel, execState);
                } else {
                    if (logChannel) await logChannel.send(`⏭️ **[조건 불만족]** \`${actualKey}\` 문자열이 없어 내부 블록을 건너뜁니다.`);
                }
            }
        }
    }

    // --- 대기열 렌더링 영역 ---
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
        try {
            const msg = await channel.messages.fetch(queueMessageId);
            await msg.edit({ embeds: [embed] });
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
        const qMsg = await channel.send({ embeds: [qEmbed] });
        queueMessageId = qMsg.id;
        await updateQueueEmbed();
    }

    // --- 시퀀스 프로세서 ---
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
            thread = await termChannel.threads.create({ name: `[진행중] 👤${user.username}님의 작업`, autoArchiveDuration: 60, type: ChannelType.PrivateThread }).catch(() => null); 
            if (thread) { activeThreadId = thread.id; await thread.send(`🛠️ **[작업 시작]** <@${user.id}> 님의 **${itemTitle}** 작업을 시작합니다.`); }
        }

        const logChannel = thread || termChannel;
        const execState = { finalOutput: '' };
        let isSuccess = true;

        try {
            ptyProcess.write('\x03'); ptyProcess.write('cd ~\r');
            await waitForTerminalReady();
            
            // 파싱된 AST 트리 실행
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
        if (thread) { await thread.setName(`[완료] 👤${user.username}님의 작업`); await thread.setArchived(true); }
        activeThreadId = null; currentTask = null; isExecuting = false;
        await updateQueueEmbed();
        if (sequenceQueue.length > 0) setTimeout(processQueue, 3000); 
    }

    client.once('ready', async () => {
        console.log(`봇 온라인: ${client.user.tag}`);
        const app = await client.application.fetch();
        ownerId = app.owner.ownerId ? app.owner.ownerId : app.owner.id;

        const commands = [
            { name: '터미널설정', description: '이 채널을 터미널로 설정합니다. (초기화 됨)' },
            { name: '티켓수설정', description: '유저의 티켓 수를 지정합니다.', options: [{type: 6, name: '유저', description: '대상 유저', required: true}, {type: 4, name: '수량', description: '티켓 수량', required: true}] },
            { name: '티켓주기', description: '유저에게 티켓을 지급합니다.', options: [{type: 6, name: '유저', description: '대상 유저', required: true}, {type: 4, name: '수량', description: '추가할 수량', required: true}] },
            { name: '상점방설정', description: '이 채널을 상점방으로 설정합니다.' },
            { name: '상점추가', description: '상점에 JSON 상품을 추가합니다.', options: [
                {type: 3, name: '상품id', description: '고유 ID', required: true},
                {type: 11, name: 'json파일', description: 'JSON 업로드', required: true},
                {type: 3, name: '상품제목', description: '제목', required: true},
                {type: 3, name: '상품설명', description: '설명', required: true},
                {type: 4, name: '가격', description: '가격', required: true}
            ]},
            { name: '상점제거', description: '상점 상품 제거', options: [{type: 3, name: '상품id', description: '고유 ID', required: true}] },
            { name: '업데이트', description: '최신 Gist 코드를 불러오기 위해 봇을 재부팅합니다.' },
            { name: '자동세팅', description: '부팅 시 자동 실행할 시퀀스 JSON을 등록합니다.', options: [{type: 11, name: 'json파일', description: 'Sequence 배열이 있는 JSON', required: true}] }
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
                        // 저장된 시퀀스도 AST로 파싱 후 실행
                        const ast = buildAST(db.autoSetupSequence);
                        await waitForTerminalReady();
                        await executeAST(ast, {}, { id: ownerId, username: '자동세팅' }, termChannel, execState);
                        await termChannel.send(`✅ **[자동 세팅 완료]** 터미널이 유휴 상태로 전환되었습니다.`);
                    } catch (e) {
                        await termChannel.send(`❌ **[자동 세팅 실패]** 시퀀스 구조 오류: ${e.message}`);
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
                targetChannelId = interaction.channel.id;
                db.targetChannelId = targetChannelId; saveDB(); initTerminal();
                return interaction.reply('✅ **채널 설정 및 터미널 초기화 완료.** (재부팅 시에도 유지됩니다)');
            }

            if (cmd === '업데이트') {
                await interaction.reply('🔄 **시스템을 재시작합니다.** 잠시 후 Gist에서 최신 코드를 다운로드하여 부팅됩니다.');
                setTimeout(() => { process.exit(0); }, 1000); return;
            }

            if (cmd === '자동세팅') {
                const file = interaction.options.getAttachment('json파일');
                if (!file.name.endsWith('.json')) return interaction.reply({ content: '❌ JSON 파일만 가능합니다.', ephemeral: true });
                try {
                    const response = await fetch(file.url); const jsonData = await response.json();
                    if (!jsonData.Sequence) return interaction.reply({ content: '❌ Sequence 배열이 없습니다.', ephemeral: true });
                    
                    // 등록 전 문법 유효성 검사 (실패 시 여기서 Catch됨)
                    buildAST(jsonData.Sequence);
                    
                    db.autoSetupSequence = jsonData.Sequence; saveDB();
                    return interaction.reply('✅ **자동 세팅 시퀀스 등록 완료.** (다음 재부팅 또는 /업데이트 시 실행됩니다)');
                } catch (e) {
                    return interaction.reply({ content: `❌ 파싱 에러(문법 오류): ${e.message}`, ephemeral: true });
                }
            }

            if (cmd === '상점방설정') {
                db.shopChannelId = interaction.channel.id; saveDB();
                await interaction.reply({ content: '✅ 상점 렌더링 중...', ephemeral: true }); await renderShop(interaction.channel); return;
            }

            if (cmd === '상점추가') {
                const id = interaction.options.getString('상품id');
                const file = interaction.options.getAttachment('json파일');
                const title = interaction.options.getString('상품제목');
                const desc = interaction.options.getString('상품설명');
                const price = interaction.options.getInteger('가격');
                try {
                    const response = await fetch(file.url); const jsonData = await response.json();
                    
                    // 등록 전 문법 유효성 검사
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
        }

        if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
            const itemId = interaction.customId.replace('buy_', ''); const item = db.shopItems[itemId];
            const userTickets = db.tickets[interaction.user.id] || 0;
            if (userTickets < item.price) return interaction.reply({ content: `❌ 티켓 부족`, ephemeral: true });
            activeSessions[interactio
