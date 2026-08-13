const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
const rooms = new Map();

const SUITS=['C','S','H','D'];
const RANKS=['7','8','9','K','10','A','J','Q'];
const POINTS={A:11,'10':10,K:4,Q:3,J:2,'9':0,'8':0,'7':0};
const TRUMP_ORDER=['QC','QS','QH','QD','JC','JS','JH','JD','AD','10D','KD','9D','8D','7D'];
const NONTRUMP_ORDER=['A','10','K','9','8','7'];
const deck=()=>SUITS.flatMap(s=>RANKS.map(r=>({r,s,id:r+s})));
const isTrump=c=>c.s==='D'||c.r==='Q'||c.r==='J';
const leadClass=c=>isTrump(c)?'T':c.s;
const suitName=s=>({C:'Clubs',S:'Spades',H:'Hearts',D:'Diamonds'}[s]||s);

function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function cardBeats(a,b,lead){const at=isTrump(a),bt=isTrump(b);if(at&&bt)return TRUMP_ORDER.indexOf(a.id)<TRUMP_ORDER.indexOf(b.id);if(at&&!bt)return true;if(!at&&bt)return false;if(a.s!==b.s)return a.s===lead;return NONTRUMP_ORDER.indexOf(a.r)<NONTRUMP_ORDER.indexOf(b.r)}
function legalCards(hand,trick){if(!trick.length)return hand;const lead=leadClass(trick[0].card);const follows=hand.filter(c=>lead==='T'?isTrump(c):(!isTrump(c)&&c.s===lead));return follows.length?follows:hand}
function strength(c){return isTrump(c)?200-TRUMP_ORDER.indexOf(c.id)*5:100-NONTRUMP_ORDER.indexOf(c.r)*5}
function handPower(hand){const tr=hand.filter(isTrump);return tr.length*3.2+tr.reduce((n,c)=>n+(14-TRUMP_ORDER.indexOf(c.id))*.42,0)+hand.reduce((n,c)=>n+POINTS[c.r]*.13,0)}
function createPlayer(name,socketId=null,isBot=false,avatar='🙂'){return{id:socketId||`bot-${Math.random().toString(36).slice(2,9)}`,name,isBot,avatar,hand:[],tricks:[],gameScore:0,connected:true}}
function roomCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let c;do{c='';for(let i=0;i<5;i++)c+=chars[Math.floor(Math.random()*chars.length)]}while(rooms.has(c));return c}
function sortHands(room){const sn={C:0,S:1,H:2,D:3};for(const p of room.players)p.hand.sort((a,b)=>{if(isTrump(a)!==isTrump(b))return isTrump(a)?-1:1;if(isTrump(a))return TRUMP_ORDER.indexOf(a.id)-TRUMP_ORDER.indexOf(b.id);if(a.s!==b.s)return sn[a.s]-sn[b.s];return NONTRUMP_ORDER.indexOf(a.r)-NONTRUMP_ORDER.indexOf(b.r)})}
function clampSettings(raw={}){return{allPassMode:raw.allPassMode==='doubler'?'doubler':'leaster',cracking:raw.cracking!==false,blitzers:raw.blitzers!==false,payoutUnit:[0,.25,.5,1].includes(Number(raw.payoutUnit))?Number(raw.payoutUnit):0,password:String(raw.password||'').slice(0,24)}}
function payoutLabel(room,points){if(!room.settings.payoutUnit)return `${points>0?'+':''}${points}`;const cash=points*room.settings.payoutUnit;return `${points>0?'+':''}${points} (${cash>=0?'+':''}$${cash.toFixed(2)})`}
function trickWinner(trick){if(!trick.length)return null;const lead=leadClass(trick[0].card);let win=trick[0];for(const x of trick.slice(1))if(cardBeats(x.card,win.card,lead==='T'?null:lead))win=x;return win}
function canBlitzHand(hand,type){const ids=new Set(hand.map(c=>c.id));return type==='BLACK'?ids.has('QC')&&ids.has('QS'):ids.has('QH')&&ids.has('QD')}
function eligibleCrackers(room){const g=room.game;if(!g||g.picker==null)return[];return room.players.map((p,i)=>i).filter(i=>i!==g.picker&&i!==g.partner&&!g.passed.includes(i))}
function humanIds(room){return room.players.filter(p=>!p.isBot&&p.connected).map(p=>p.id)}
function readyInfo(room,viewerId){const ids=humanIds(room);const set=room.readySet||new Set();return{needed:ids.length,ready:ids.filter(id=>set.has(id)).length,youReady:set.has(viewerId),names:ids.filter(id=>set.has(id)).map(id=>room.players.find(p=>p.id===id)?.name).filter(Boolean)}}
function resetReady(room){room.readySet=new Set()}
function allHumansReady(room){const ids=humanIds(room);return ids.length>0&&ids.every(id=>room.readySet?.has(id))}

function publicState(room,viewerId){
  const g=room.game, viewer=room.players.find(p=>p.id===viewerId), viewerSeat=room.players.findIndex(p=>p.id===viewerId);
  const callable=g&&g.picker!=null?['C','S','H'].filter(s=>{const h=room.players[g.picker].hand;return !h.some(c=>c.r==='A'&&c.s===s)&&h.some(c=>!isTrump(c)&&c.s===s)}):[];
  const canCrack=!!(g&&room.phase==='doubling'&&room.settings.cracking&&g.crackCount===0&&eligibleCrackers(room).includes(viewerSeat));
  const canRecrack=!!(g&&room.phase==='doubling'&&room.settings.cracking&&g.crackCount===1&&(viewerSeat===g.picker||viewerSeat===g.partner));
  const blitzOptions=[];
  if(g&&room.phase==='doubling'&&room.settings.blitzers&&viewer){for(const t of ['BLACK','RED'])if(canBlitzHand(viewer.hand,t)&&!g.blitzedBy.some(x=>x.seat===viewerSeat&&x.type===t))blitzOptions.push(t)}
  const readyPhases=['lobby','doubling','trickEnd','roundEnd'];
  return{
    code:room.code,hostId:room.hostId,phase:room.phase,settings:{...room.settings,password:room.settings.password?'••••':''},
    players:room.players.map((p,i)=>({id:p.id,name:p.name,avatar:p.avatar,isBot:p.isBot,connected:p.connected,seat:i,cards:p.hand.length,tricks:p.tricks.length/5,gameScore:p.gameScore,payout:payoutLabel(room,p.gameScore)})),
    you:viewerId,dealer:g?.dealer??room.pendingDeal?.dealer??0,current:g?.current??null,picker:g?.picker??null,calledSuit:g?.calledSuit??null,
    partner:g?.partnerRevealed?(g?.partner??null):null,partnerRevealed:g?.partnerRevealed??false,alone:g?.alone??false,trick:g?.trick??[],trickNo:g?.trickNo??0,
    trickWinner:g?.lastTrickWinner??null,teamPoints:g?.teamPoints??null,message:room.message||'',hand:viewer?.hand||[],
    legal:g&&['playing','leaster'].includes(room.phase)&&room.players[g.current]?.id===viewerId?legalCards(room.players[g.current].hand,g.trick).map(c=>c.id):[],
    canPick:g&&room.phase==='picking'&&room.players[g.current]?.id===viewerId,canDiscard:g&&room.phase==='discard'&&room.players[g.picker]?.id===viewerId,
    canCall:g&&room.phase==='call'&&room.players[g.picker]?.id===viewerId,callableSuits:callable,canCrack,canRecrack,blitzOptions,multiplier:g?.multiplier??room.pendingDeal?.multiplier??1,
    announcementLines:(g?.announcements||[]),introVisible:!!(g&&g.announcements?.length&&['discard','call','doubling','playing'].includes(room.phase)&&g.trickNo===0&&g.trick.length===0),
    history:room.history.slice(-12).reverse(),roundNumber:room.roundNumber||0,leaster:room.phase==='leaster',ready:readyPhases.includes(room.phase)?readyInfo(room,viewerId):null,
    shuffling:room.phase==='shuffling',collecting:room.phase==='collecting'
  }
}
function emit(room){for(const p of room.players.filter(p=>!p.isBot&&p.connected))io.to(p.id).emit('state',publicState(room,p.id))}
function fillBots(room){const bots=[['Otto','🧔'],['Mabel','👩‍🦳'],['Fritz','🧢'],['Greta','👩'],['Walter','👨‍🦰']];while(room.players.length<5){const [n,a]=bots[room.players.length];room.players.push(createPlayer(n,null,true,a))}}

function beginShuffle(room,mode='normal',carryMultiplier=1){
  fillBots(room);
  const prevDealer=room.game?.dealer??-1;
  const dealer=(prevDealer+1)%5;
  room.pendingDeal={mode,carryMultiplier,dealer,multiplier:carryMultiplier};
  for(const p of room.players){p.hand=[];p.tricks=[]}
  room.game={dealer,current:null,picker:null,blind:[],discard:[],calledSuit:null,partner:null,partnerRevealed:false,alone:false,trick:[],trickNo:0,passed:[],teamPoints:null,multiplier:carryMultiplier,crackCount:0,blitzedBy:[],announcements:[],mode,lastTrickWinner:null};
  room.phase='shuffling';
  room.message=`${room.players[dealer].name} is shuffling…`;
  resetReady(room);emit(room);
  setTimeout(()=>{if(room.phase==='shuffling'&&room.pendingDeal?.dealer===dealer)dealRound(room,mode,carryMultiplier,dealer)},3100);
}
function dealRound(room,mode='normal',carryMultiplier=1,dealerOverride=null){
  fillBots(room);const dealer=dealerOverride??((room.game?.dealer??-1)+1)%5;const d=shuffle(deck());for(const p of room.players){p.hand=[];p.tricks=[]}let idx=0,blind=[];
  for(let pass=0;pass<2;pass++){for(let i=1;i<=5;i++){const seat=(dealer+i)%5;room.players[seat].hand.push(...d.slice(idx,idx+3));idx+=3;if(pass===0&&i===2){blind=d.slice(idx,idx+2);idx+=2}}}
  room.pendingDeal=null;room.roundNumber=(room.roundNumber||0)+1;
  room.game={dealer,current:(dealer+1)%5,picker:null,blind,discard:[],calledSuit:null,partner:null,partnerRevealed:false,alone:false,trick:[],trickNo:0,passed:[],teamPoints:null,multiplier:carryMultiplier,crackCount:0,blitzedBy:[],announcements:[],mode,lastTrickWinner:null};sortHands(room);
  if(mode==='leaster'){room.phase='leaster';room.message='Leaster: lowest card-point total with at least one trick wins.';emit(room);scheduleBots(room)}
  else{room.phase='picking';room.message=`${room.players[room.game.current].name} decides first.`;emit(room);scheduleBots(room)}
}
function startRound(room){const mult=room.nextMultiplier||1;room.nextMultiplier=1;beginShuffle(room,'normal',mult)}
function actPick(room,seat,pick){const g=room.game;if(room.phase!=='picking'||g.current!==seat)return;if(pick){g.picker=seat;room.players[seat].hand.push(...g.blind);g.blind=[];sortHands(room);room.phase='discard';g.announcements=[`${room.players[seat].name.toUpperCase()} PICKED`];room.message=`${room.players[seat].name} picked. Discard two cards.`;}else{g.passed.push(seat);if(g.passed.length===5){if(room.settings.allPassMode==='leaster'){room.message='Everyone passed — leaster coming up.';emit(room);return setTimeout(()=>beginShuffle(room,'leaster',g.multiplier),700)}room.nextMultiplier=Math.min(16,(room.nextMultiplier||1)*2);room.message=`Everyone passed — next hand is a x${room.nextMultiplier} doubler.`;emit(room);return setTimeout(()=>startRound(room),900)}g.current=(g.current+1)%5;room.message=`${room.players[seat].name} passed. ${room.players[g.current].name} decides.`}emit(room);scheduleBots(room)}
function discard(room,seat,ids){const g=room.game;if(room.phase!=='discard'||g.picker!==seat||!Array.isArray(ids)||ids.length!==2)return;const p=room.players[seat];const cards=ids.map(id=>p.hand.find(c=>c.id===id));if(cards.some(c=>!c))return;p.hand=p.hand.filter(c=>!ids.includes(c.id));g.discard=cards;room.phase='call';room.message=`${p.name}: call a partner ace, or go alone.`;emit(room);scheduleBots(room)}
function callPartner(room,seat,suit){const g=room.game;if(room.phase!=='call'||g.picker!==seat)return;if(suit==='ALONE'){g.alone=true;g.partner=null;g.partnerRevealed=false;g.calledSuit=null}else{const h=room.players[seat].hand;const valid=['C','S','H'].includes(suit)&&!h.some(c=>c.r==='A'&&c.s===suit)&&h.some(c=>!isTrump(c)&&c.s===suit);if(!valid)return;g.calledSuit=suit;g.partnerRevealed=false;g.partner=room.players.findIndex((p,i)=>i!==seat&&p.hand.some(c=>c.r==='A'&&c.s===suit));if(g.partner<0){g.alone=true;g.partner=null}}room.phase='doubling';g.current=(g.dealer+1)%5;g.trick=[];g.announcements.push(g.alone?'GOING ALONE':`CALLED ACE OF ${suitName(suit).toUpperCase()}`);room.message=g.alone?`${room.players[seat].name} is going alone. Everyone press Start Play when ready.`:`${room.players[seat].name} called the Ace of ${suitName(suit)}. Everyone press Start Play when ready.`;resetReady(room);emit(room);scheduleBots(room)}
function applyDouble(room,seat,type){const g=room.game;if(room.phase!=='doubling')return;
  if(type==='CRACK'&&room.settings.cracking&&g.crackCount===0&&eligibleCrackers(room).includes(seat)){g.crackCount=1;g.multiplier=Math.min(16,g.multiplier*2);room.message=`${room.players[seat].name} cracked! x${g.multiplier}`;g.announcements.push(`${room.players[seat].name.toUpperCase()} CRACKED — ×${g.multiplier}`)}
  else if(type==='RECRACK'&&room.settings.cracking&&g.crackCount===1&&(seat===g.picker||seat===g.partner)){g.crackCount=2;g.multiplier=Math.min(16,g.multiplier*2);room.message=`${room.players[seat].name} re-cracked! x${g.multiplier}`;g.announcements.push(`${room.players[seat].name.toUpperCase()} RE-CRACKED — ×${g.multiplier}`)}
  else if((type==='BLACK'||type==='RED')&&room.settings.blitzers&&canBlitzHand(room.players[seat].hand,type)&&!g.blitzedBy.some(x=>x.seat===seat&&x.type===type)){g.blitzedBy.push({seat,type});g.multiplier=Math.min(16,g.multiplier*2);room.message=`${room.players[seat].name} called ${type==='BLACK'?'black':'red'} blitzers! x${g.multiplier}`;g.announcements.push(`${room.players[seat].name.toUpperCase()} — ${type} QUEENS BLITZ ×${g.multiplier}`)}
  else return;emit(room);scheduleBots(room)}
function beginPlay(room){const g=room.game;if(room.phase!=='doubling')return;room.phase='playing';g.current=(g.dealer+1)%5;g.announcements.push(`PLAY BEGINS${g.multiplier>1?` — ×${g.multiplier}`:''}`,`${room.players[g.current].name.toUpperCase()} LEADS`);room.message=`Play begins${g.multiplier>1?` at x${g.multiplier}`:''}. ${room.players[g.current].name} leads.`;resetReady(room);emit(room);scheduleBots(room)}
function playCard(room,seat,id){const g=room.game;if(!['playing','leaster'].includes(room.phase)||g.current!==seat)return;const p=room.players[seat];const card=p.hand.find(c=>c.id===id);if(!card||!legalCards(p.hand,g.trick).some(c=>c.id===id))return;p.hand=p.hand.filter(c=>c.id!==id);if(room.phase==='playing'&&g.partner!=null&&!g.partnerRevealed&&seat===g.partner&&g.calledSuit&&card.r==='A'&&card.s===g.calledSuit){g.partnerRevealed=true;room.message=`${p.name} is the partner!`}g.trick.push({seat,card});if(g.trick.length<5){g.current=(g.current+1)%5;room.message=`${room.players[g.current].name}'s turn.`;emit(room);scheduleBots(room);return}const win=trickWinner(g.trick);room.players[win.seat].tricks.push(...g.trick.map(x=>x.card));g.current=win.seat;g.lastTrickWinner=win.seat;g.trickNo++;room.phase='trickEnd';room.message=`${room.players[win.seat].name} took trick ${g.trickNo}. Everyone press Next Trick.`;resetReady(room);emit(room)}
function advanceAfterTrick(room){const g=room.game;if(room.phase!=='trickEnd')return;resetReady(room);room.phase='collecting';room.message=`${room.players[g.lastTrickWinner].name} gathers the trick.`;emit(room);setTimeout(()=>{if(room.phase!=='collecting')return;if(g.trickNo===6){g.trick=[];return g.mode==='leaster'?scoreLeaster(room):scoreRound(room)}g.trick=[];g.lastTrickWinner=null;room.phase=g.mode==='leaster'?'leaster':'playing';room.message=`${room.players[g.current].name} leads trick ${g.trickNo+1}.`;emit(room);scheduleBots(room)},1150)}
function baseScore(pp,op,pickerTricks,oppTricks){const won=pp>=61;if(won){if(oppTricks===0)return 3;if(op<=30)return 2;return 1}else{if(pickerTricks===0)return 3;if(pp<=30)return 2;return 1}}
function scoreRound(room){const g=room.game;const pickerTeam=[g.picker,...(g.partner!=null?[g.partner]:[])];let pp=g.discard.reduce((s,c)=>s+POINTS[c.r],0),op=0,pt=0,ot=0;room.players.forEach((p,i)=>{const pts=p.tricks.reduce((s,c)=>s+POINTS[c.r],0);if(pickerTeam.includes(i)){pp+=pts;pt+=p.tricks.length/5}else{op+=pts;ot+=p.tricks.length/5}});g.teamPoints={picker:pp,opponents:op};const won=pp>=61,b=baseScore(pp,op,pt,ot)*g.multiplier;const delta=Array(5).fill(0);if(g.partner==null){delta[g.picker]=(won?4:-4)*b;room.players.forEach((p,i)=>{if(i!==g.picker)delta[i]=(won?-1:1)*b})}else{delta[g.picker]=(won?2:-2)*b;delta[g.partner]=(won?1:-1)*b;room.players.forEach((p,i)=>{if(!pickerTeam.includes(i))delta[i]=(won?-1:1)*b})}room.players.forEach((p,i)=>p.gameScore+=delta[i]);room.phase='roundEnd';const label=`Picker team ${won?'wins':'loses'} ${pp}–${op}${g.multiplier>1?` (x${g.multiplier})`:''}.`;room.message=`${label} Everyone press Next Round.`;room.history.push({round:room.roundNumber,type:'Normal',summary:label,delta:room.players.map((p,i)=>({name:p.name,change:delta[i]}))});resetReady(room);emit(room)}
function scoreLeaster(room){const g=room.game;const lastWinner=g.current;if(g.blind.length)room.players[lastWinner].tricks.push(...g.blind);const totals=room.players.map(p=>p.tricks.reduce((s,c)=>s+POINTS[c.r],0));const eligible=room.players.map((p,i)=>({i,pts:totals[i],tricks:p.tricks.length/5})).filter(x=>x.tricks>0);const min=Math.min(...eligible.map(x=>x.pts));const winners=eligible.filter(x=>x.pts===min);const delta=Array(5).fill(0);let summary;if(winners.length===1){const w=winners[0].i,m=g.multiplier;delta[w]=4*m;room.players.forEach((p,i)=>{if(i!==w)delta[i]=-1*m});summary=`Leaster: ${room.players[w].name} wins with ${min} points.`}else summary=`Leaster tie at ${min} points — no score.`;room.players.forEach((p,i)=>p.gameScore+=delta[i]);room.phase='roundEnd';room.message=`${summary} Everyone press Next Round.`;room.history.push({round:room.roundNumber,type:'Leaster',summary,delta:room.players.map((p,i)=>({name:p.name,change:delta[i]}))});resetReady(room);emit(room)}
function botPickScore(hand){
  const tr=hand.filter(isTrump), top=new Set(['QC','QS','QH','QD','JC','JS']);
  const offAces=hand.filter(c=>!isTrump(c)&&c.r==='A').length;
  const offTens=hand.filter(c=>!isTrump(c)&&c.r==='10').length;
  const topTrump=tr.filter(c=>top.has(c.id)).length;
  const suitCounts=['C','S','H'].map(s=>hand.filter(c=>!isTrump(c)&&c.s===s).length);
  const voids=suitCounts.filter(n=>n===0).length;
  return tr.length*4.25+topTrump*2.3+offAces*2.4+offTens*.7+voids*.7+hand.reduce((n,c)=>n+POINTS[c.r]*.08,0);
}
function botShouldPick(room,seat){
  const g=room.game, hand=room.players[seat].hand, score=botPickScore(hand);
  const trumps=hand.filter(isTrump).length, queens=hand.filter(c=>c.r==='Q').length;
  // Later seats can loosen up a little, but bots still pass marginal hands.
  const late=Math.min(2.2,g.passed.length*.55);
  const threshold=19.2-late;
  return score>=threshold || (trumps>=4&&score>=16.5) || (queens>=2&&trumps>=3);
}
function botDiscard(hand){
  // Picker has 8 cards after taking the blind. Score every possible 2-card bury
  // and always return two distinct card IDs from the CURRENT hand.
  if(!Array.isArray(hand)||hand.length<2)return [];
  let best=null;
  for(let i=0;i<hand.length-1;i++)for(let j=i+1;j<hand.length;j++){
    const pair=[hand[i],hand[j]], keep=hand.filter((_,k)=>k!==i&&k!==j);
    let score=pair.reduce((n,c)=>n+(POINTS[c.r]||0)*1.45,0);
    for(const c of pair){
      if(isTrump(c)){
        const ti=TRUMP_ORDER.indexOf(c.id);
        score-=11+Math.max(0,14-(ti<0?14:ti))*.9;
      }
      if(!isTrump(c)&&c.r==='A')score-=15;
      if(!isTrump(c)&&c.r==='10')score+=3;
      if(!isTrump(c)&&c.r==='K')score+=1.5;
    }
    for(const suit of ['C','S','H']){
      const before=hand.filter(c=>!isTrump(c)&&c.s===suit).length;
      const after=keep.filter(c=>!isTrump(c)&&c.s===suit).length;
      if(before>0&&after===0)score+=5.5;
      if(after===1&&keep.some(c=>!isTrump(c)&&c.s===suit&&c.r==='A'))score+=1.5;
    }
    const callable=['C','S','H'].filter(s=>!keep.some(c=>c.r==='A'&&c.s===s)&&keep.some(c=>!isTrump(c)&&c.s===s));
    const aloneQuality=botPickScore(keep)>=27&&keep.filter(isTrump).length>=5;
    if(!callable.length&&!aloneQuality)score-=18;
    if(!best||score>best.score)best={score,ids:[pair[0].id,pair[1].id]};
  }
  return best?.ids||hand.slice(0,2).map(c=>c.id);
}

function runBotDiscard(room,seat){
  // Bot pickup/discard uses its own state transition instead of routing through
  // the human discard handler. This avoids a bot ever getting stranded in the
  // discard phase after taking the blind.
  if(!room?.game||room.phase!=='discard'||room.game.picker!==seat)return false;
  const p=room.players[seat];
  if(!p?.isBot||!Array.isArray(p.hand)||p.hand.length<2)return false;

  const chooseValidIds=()=>{
    const currentIds=new Set(p.hand.map(c=>c.id));
    let ids=[];
    try{ ids=botDiscard(p.hand); }catch(err){ console.error('Smart bot discard failed:',err); }
    const valid=x=>Array.isArray(x)&&x.length===2&&x[0]!==x[1]&&x.every(id=>currentIds.has(id));
    if(!valid(ids)){
      try{ ids=fallbackBotDiscard(p.hand); }catch(err){ console.error('Fallback bot discard failed:',err); }
    }
    if(!valid(ids))ids=p.hand.slice(0,2).map(c=>c.id);
    return valid(ids)?ids:null;
  };

  const ids=chooseValidIds();
  if(!ids)return false;
  const cards=ids.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean);
  if(cards.length!==2)return false;

  // Commit the discard atomically from the bot's current 8-card hand.
  const bury=new Set(ids);
  p.hand=p.hand.filter(c=>!bury.has(c.id));
  if(p.hand.length!==6){
    // Restore and fail safely if anything unexpected happened.
    p.hand.push(...cards);
    sortHands(room);
    return false;
  }
  room.game.discard=cards;
  room.phase='call';
  room.message=`${p.name} buried two cards and is choosing a partner.`;
  console.log(`[BOT] ${p.name} discarded ${ids.join(', ')}; 6 cards remain.`);
  emit(room);
  scheduleBots(room);
  return true;
}

function botCallChoice(hand){
  const trumps=hand.filter(isTrump).length;
  if(trumps>=5&&botPickScore(hand)>=27.5)return 'ALONE';
  const choices=['C','S','H'].filter(s=>!hand.some(c=>c.r==='A'&&c.s===s)&&hand.some(c=>!isTrump(c)&&c.s===s));
  if(!choices.length)return 'ALONE';
  const rankCost={7:0,8:1,9:2,K:4,'10':7,A:9};
  choices.sort((a,b)=>{
    const ah=hand.filter(c=>!isTrump(c)&&c.s===a), bh=hand.filter(c=>!isTrump(c)&&c.s===b);
    const as=ah.length*5+Math.min(...ah.map(c=>rankCost[c.r]??5));
    const bs=bh.length*5+Math.min(...bh.map(c=>rankCost[c.r]??5));
    return as-bs;
  });
  return choices[0];
}
function trickPoints(trick){return trick.reduce((n,x)=>n+POINTS[x.card.r],0)}
function lowToHigh(cards){return [...cards].sort((a,b)=>strength(a)-strength(b))}
function cheapWinner(cards,current,lead){return lowToHigh(cards.filter(c=>cardBeats(c,current.card,lead)))[0]||null}
function knownSameTeam(g,seat,other){
  if(seat===other)return true;
  if(g.mode==='leaster')return false;
  if(seat===g.picker)return g.partnerRevealed&&other===g.partner;
  if(seat===g.partner)return other===g.picker;
  if(other===g.picker)return false;
  if(g.partnerRevealed&&other===g.partner)return false;
  // Defenders know other non-picker, non-revealed-partner seats are defenders only after partner is public.
  return g.partnerRevealed && seat!==g.partner && other!==g.partner;
}
function botLead(room,seat,legal){
  const g=room.game,p=room.players[seat], tr=legal.filter(isTrump), off=legal.filter(c=>!isTrump(c));
  const offAces=off.filter(c=>c.r==='A');
  if(g.mode==='leaster'){
    // Avoid taking control: lead low cards; avoid aces and high trump unless forced.
    return [...legal].sort((a,b)=>(POINTS[a.r]*30+strength(a))-(POINTS[b.r]*30+strength(b)))[0];
  }
  if(seat===g.picker){
    // Picker usually wants to pull trump early when strong, then cash side aces.
    if(g.trickNo<=2&&tr.length>=2){
      const ordered=[...tr].sort((a,b)=>TRUMP_ORDER.indexOf(a.id)-TRUMP_ORDER.indexOf(b.id));
      return ordered[Math.min(ordered.length-1,Math.max(0,Math.floor(ordered.length/2)-1))];
    }
    if(offAces.length)return offAces[0];
    if(tr.length)return lowToHigh(tr)[0];
  }
  if(seat===g.partner){
    // Partner supports picker with a useful ace, otherwise preserves trump for captures.
    const safeAce=offAces.find(c=>!g.calledSuit||c.s!==g.calledSuit)||offAces[0];
    if(safeAce)return safeAce;
    if(off.length)return lowToHigh(off)[0];
  }
  // Defenders cash side aces and otherwise lead low off-suit cards to probe picker/partner.
  if(offAces.length)return offAces[0];
  if(off.length){
    const bySuit=[...off].sort((a,b)=>{
      const ca=p.hand.filter(c=>!isTrump(c)&&c.s===a.s).length, cb=p.hand.filter(c=>!isTrump(c)&&c.s===b.s).length;
      return ca-cb || strength(a)-strength(b);
    });
    return bySuit[0];
  }
  return lowToHigh(tr)[0];
}
function botPlay(room,seat){
  const g=room.game,p=room.players[seat],legal=legalCards(p.hand,g.trick);
  if(!g.trick.length)return botLead(room,seat,legal).id;
  const lead=leadClass(g.trick[0].card)==='T'?null:leadClass(g.trick[0].card);
  const current=trickWinner(g.trick), pts=trickPoints(g.trick), last=g.trick.length===4;
  const winners=legal.filter(c=>cardBeats(c,current.card,lead));
  const losers=legal.filter(c=>!cardBeats(c,current.card,lead));

  if(g.mode==='leaster'){
    // In a leaster, avoid winning if possible; if forced to win, use the least costly winner.
    if(losers.length)return [...losers].sort((a,b)=>(POINTS[a.r]*25+strength(a))-(POINTS[b.r]*25+strength(b)))[0].id;
    return [...winners].sort((a,b)=>(POINTS[a.r]*25+strength(a))-(POINTS[b.r]*25+strength(b)))[0].id;
  }

  const teammateWinning=knownSameTeam(g,seat,current.seat);
  if(teammateWinning){
    // Feed points to a known teammate without unnecessarily overtaking them.
    if(losers.length){
      return [...losers].sort((a,b)=>(POINTS[b.r]-POINTS[a.r]) || (strength(a)-strength(b)))[0].id;
    }
    return lowToHigh(legal)[0].id;
  }

  if(winners.length){
    const cheapest=cheapWinner(legal,current,lead);
    // Take valuable tricks, always take on last seat, and be more aggressive against the picker.
    const currentIsPicker=current.seat===g.picker;
    if(last||pts>=10||currentIsPicker||POINTS[cheapest.r]<=4)return cheapest.id;
  }

  // Can't/shouldn't win: shed low-risk cards. When an opponent is winning, don't donate an A/10 unless forced.
  const pool=losers.length?losers:legal;
  return [...pool].sort((a,b)=>{
    const riskA=(POINTS[a.r]*9)+(isTrump(a)?strength(a)*.04:0);
    const riskB=(POINTS[b.r]*9)+(isTrump(b)?strength(b)*.04:0);
    return riskA-riskB || strength(a)-strength(b);
  })[0].id;
}
function botDoubleDecision(room,x){
  const g=room.game, score=botPickScore(x.p.hand), trumps=x.p.hand.filter(isTrump).length;
  if(room.settings.blitzers){
    for(const t of ['BLACK','RED'])if(canBlitzHand(x.p.hand,t)&&!g.blitzedBy.some(y=>y.seat===x.i&&y.type===t))return t;
  }
  if(room.settings.cracking&&g.crackCount===0&&eligibleCrackers(room).includes(x.i)&&score>=24.5&&trumps>=3)return 'CRACK';
  if(room.settings.cracking&&g.crackCount===1&&(x.i===g.picker||x.i===g.partner)&&score>=26.5)return 'RECRACK';
  return null;
}
function fallbackBotDiscard(hand){
  const score=c=>{let v=(isTrump(c)?80:0)+POINTS[c.r]*2;if(['A','10'].includes(c.r)&&!isTrump(c))v+=24;return v};
  return [...hand].sort((a,b)=>score(a)-score(b)).slice(0,2).map(c=>c.id);
}
function fallbackBotCall(hand){
  const suits=['C','S','H'].filter(s=>!hand.some(c=>c.r==='A'&&c.s===s)&&hand.some(c=>!isTrump(c)&&c.s===s));
  return suits[0]||'ALONE';
}
function fallbackBotPlay(room,seat){
  const g=room.game,p=room.players[seat],legal=legalCards(p.hand,g.trick);
  if(!legal.length)return null;
  if(g.mode==='leaster')return [...legal].sort((a,b)=>(POINTS[a.r]*20+strength(a))-(POINTS[b.r]*20+strength(b)))[0].id;
  if(!g.trick.length){const off=legal.filter(c=>!isTrump(c)).sort((a,b)=>strength(a)-strength(b));return (off[0]||[...legal].sort((a,b)=>strength(a)-strength(b))[0]).id}
  const current=trickWinner(g.trick),lead=leadClass(g.trick[0].card)==='T'?null:leadClass(g.trick[0].card);
  const winners=legal.filter(c=>cardBeats(c,current.card,lead)).sort((a,b)=>strength(a)-strength(b));
  return (winners[0]||[...legal].sort((a,b)=>strength(a)-strength(b))[0]).id;
}
function scheduleBots(room){
  if(!room?.game)return;

  // Doubling is not a turn-based phase. Give one bot at a time a chance to
  // make a declaration; applyDouble() calls scheduleBots() again afterward.
  if(room.phase==='doubling'){
    for(const x of room.players.map((p,i)=>({p,i})).filter(x=>x.p.isBot)){
      let move=null;
      try{ move=botDoubleDecision(room,x); }catch(err){ console.error('Bot double decision failed:',err); }
      if(move){
        return setTimeout(()=>{
          if(room.phase==='doubling')applyDouble(room,x.i,move);
        },700);
      }
    }
    return;
  }

  let seat=null;
  if(room.phase==='discard'||room.phase==='call')seat=room.game.picker;
  else if(['picking','playing','leaster'].includes(room.phase))seat=room.game.current;
  else return;

  const p=room.players[seat];
  if(!p?.isBot)return;
  const expectedPhase=room.phase;

  setTimeout(()=>{
    // Re-read current state when the timer fires. If this bot no longer owns
    // the turn, simply schedule the current bot rather than freezing the game.
    if(!room.game)return;
    const currentSeat=(room.phase==='discard'||room.phase==='call')?room.game.picker:room.game.current;
    if(room.phase!==expectedPhase||currentSeat!==seat||!room.players[seat]?.isBot){
      return scheduleBots(room);
    }

    try{
      if(room.phase==='picking'){
        let pick;
        try{pick=botShouldPick(room,seat)}catch(err){console.error('Smart bot pick failed:',err);pick=handPower(p.hand)>19||(room.game.passed.length>=3&&handPower(p.hand)>16)}
        return actPick(room,seat,!!pick);
      }
      if(room.phase==='discard'){
        if(runBotDiscard(room,seat))return;
        // Watchdog: if a malformed hand/state ever prevents the smart discard,
        // retry from fresh room state instead of leaving the table frozen.
        console.error(`[BOT] discard retry for seat ${seat}`);
        return setTimeout(()=>{
          if(room.phase==='discard'&&room.game?.picker===seat&&room.players[seat]?.isBot){
            if(!runBotDiscard(room,seat)){
              const fresh=room.players[seat]?.hand||[];
              if(fresh.length>=2){
                const ids=fresh.slice(-2).map(c=>c.id);
                const cards=ids.map(id=>fresh.find(c=>c.id===id)).filter(Boolean);
                const bury=new Set(ids);
                room.players[seat].hand=fresh.filter(c=>!bury.has(c.id));
                room.game.discard=cards;
                room.phase='call';
                room.message=`${room.players[seat].name} buried two cards and is choosing a partner.`;
                emit(room);scheduleBots(room);
              }
            }
          }
        },250);
      }
      if(room.phase==='call'){
        let suit;
        try{suit=botCallChoice(p.hand)}catch(err){console.error('Smart bot call failed:',err);suit=fallbackBotCall(p.hand)}
        const before=room.phase;
        callPartner(room,seat,suit);
        // If a smart call was rejected by a house-rule edge case, make a safe call.
        if(room.phase===before)callPartner(room,seat,fallbackBotCall(p.hand));
        return;
      }
      if(room.phase==='playing'||room.phase==='leaster'){
        let id;
        try{id=botPlay(room,seat)}catch(err){console.error('Smart bot play failed:',err);id=fallbackBotPlay(room,seat)}
        const legal=legalCards(p.hand,room.game.trick).map(c=>c.id);
        if(!legal.includes(id))id=fallbackBotPlay(room,seat);
        if(id)return playCard(room,seat,id);
      }
    }catch(err){
      console.error('Bot turn failed:',err);
      // Last-resort fallback: never leave a bot turn permanently stuck.
      if(room.phase==='picking'&&room.game.current===seat)return actPick(room,seat,handPower(p.hand)>18);
      if(room.phase==='discard'&&room.game.picker===seat){if(runBotDiscard(room,seat))return;const h=room.players[seat]?.hand||[];if(h.length>=2)return discard(room,seat,[h[0].id,h[1].id]);}
      if(room.phase==='call'&&room.game.picker===seat)return callPartner(room,seat,fallbackBotCall(p.hand));
      if(['playing','leaster'].includes(room.phase)&&room.game.current===seat){const id=fallbackBotPlay(room,seat);if(id)return playCard(room,seat,id)}
    }
  },950+Math.random()*450);
}

function markReady(room,socketId,kind){
  if(!room||!humanIds(room).includes(socketId))return;
  const allowed={lobby:'START',doubling:'PLAY',trickEnd:'TRICK',roundEnd:'ROUND'};
  if(allowed[room.phase]!==kind)return;
  room.readySet??=new Set();room.readySet.add(socketId);
  const info=readyInfo(room,socketId);room.message=`${info.ready}/${info.needed} human player${info.needed===1?'':'s'} ready.`;emit(room);
  if(!allHumansReady(room))return;
  if(room.phase==='lobby')startRound(room);
  else if(room.phase==='doubling')beginPlay(room);
  else if(room.phase==='trickEnd')advanceAfterTrick(room);
  else if(room.phase==='roundEnd')startRound(room);
}
function maybeAdvanceBarrier(room){if(!room||!['lobby','doubling','trickEnd','roundEnd'].includes(room.phase)||!allHumansReady(room))return;if(room.phase==='lobby')startRound(room);else if(room.phase==='doubling')beginPlay(room);else if(room.phase==='trickEnd')advanceAfterTrick(room);else if(room.phase==='roundEnd')startRound(room)}

io.on('connection',socket=>{
 socket.on('createRoom',({name,avatar,settings})=>{const code=roomCode(),player=createPlayer((name||'Player').slice(0,18),socket.id,false,String(avatar||'🙂').slice(0,4)),room={code,hostId:socket.id,players:[player],phase:'lobby',game:null,message:'Invite friends. Every human presses Start when ready.',settings:clampSettings(settings),history:[],roundNumber:0,nextMultiplier:1,readySet:new Set(),pendingDeal:null};rooms.set(code,room);socket.join(code);socket.data.code=code;emit(room)});
 socket.on('joinRoom',({code,name,avatar,password})=>{code=(code||'').toUpperCase().trim();const room=rooms.get(code);if(!room)return socket.emit('errorMsg','Room not found.');if(room.phase!=='lobby')return socket.emit('errorMsg','That game already started.');if(room.settings.password&&String(password||'')!==room.settings.password)return socket.emit('errorMsg','Wrong table password.');if(room.players.length>=5)return socket.emit('errorMsg','Room is full.');room.players.push(createPlayer((name||'Player').slice(0,18),socket.id,false,String(avatar||'🙂').slice(0,4)));socket.join(code);socket.data.code=code;room.message='Every human presses Start when ready.';emit(room)});
 socket.on('readyStart',()=>markReady(rooms.get(socket.data.code),socket.id,'START'));
 socket.on('readyPlay',()=>markReady(rooms.get(socket.data.code),socket.id,'PLAY'));
 socket.on('nextTrick',()=>markReady(rooms.get(socket.data.code),socket.id,'TRICK'));
 socket.on('nextRound',()=>markReady(rooms.get(socket.data.code),socket.id,'ROUND'));
 socket.on('pick',({pick})=>{const room=rooms.get(socket.data.code);if(room)actPick(room,room.players.findIndex(p=>p.id===socket.id),!!pick)});
 socket.on('discard',({ids})=>{const room=rooms.get(socket.data.code);if(room)discard(room,room.players.findIndex(p=>p.id===socket.id),ids)});
 socket.on('call',({suit})=>{const room=rooms.get(socket.data.code);if(room)callPartner(room,room.players.findIndex(p=>p.id===socket.id),suit)});
 socket.on('double',({type})=>{const room=rooms.get(socket.data.code);if(room)applyDouble(room,room.players.findIndex(p=>p.id===socket.id),type)});
 socket.on('play',({id})=>{const room=rooms.get(socket.data.code);if(room)playCard(room,room.players.findIndex(p=>p.id===socket.id),id)});
 socket.on('disconnect',()=>{const room=rooms.get(socket.data.code);if(!room)return;const p=room.players.find(p=>p.id===socket.id);if(p){p.connected=false;room.readySet?.delete(socket.id);if(room.phase==='lobby')room.players=room.players.filter(x=>x.id!==socket.id);else{p.isBot=true;p.name=p.name.replace(/ \(Bot\)$/,'')+' (Bot)';scheduleBots(room)}emit(room);maybeAdvanceBarrier(room)}})
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Sheepshead running on http://0.0.0.0:${PORT}`));
