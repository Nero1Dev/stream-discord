# Stream de Tela

Compartilhe sua tela com amigos por um link. O vídeo vai direto do seu navegador para o deles (WebRTC peer-to-peer via [PeerJS](https://peerjs.com)), sem servidor de vídeo.

## Testar localmente

```bash
npm start
```

Abra http://localhost:3000, clique em **Compartilhar tela** e abra o link gerado em outra aba.

## Compartilhar com amigos

Seus amigos precisam acessar a página por um endereço público com **HTTPS**. Publique a pasta como site estático (de graça), por exemplo:

- **Netlify Drop**: arraste a pasta em https://app.netlify.com/drop
- **GitHub Pages**: suba os arquivos num repositório e ative o Pages
- **Cloudflare Pages / Vercel**: importe a pasta ou o repositório

Depois abra o site publicado, clique em **Compartilhar tela** e mande o link para seus amigos.

## Revezar quem compartilha

Qualquer pessoa na sala pode clicar em **Pedir para compartilhar**. Ela já escolhe a tela nesse momento, e o pedido aparece para quem está transmitindo, que pode **Aceitar e trocar** ou **Recusar**. Se ninguém estiver transmitindo, quem clicar começa direto.

## Observações

- Quem criou o link coordena a sala (★ na lista). Se essa pessoa sair, a coordenação passa para a próxima na ordem de entrada, e assim por diante. Quem estiver compartilhando continua transmitindo durante a troca.
- O link continua valendo enquanto alguém estiver na sala. Se a sala ficar vazia, quem abrir o link de novo reabre a sala.
- **Áudio**: no Chrome/Edge, marque "Compartilhar áudio" na janela de seleção da tela.
- Cada pessoa recebe uma cópia do stream enviada pelo upload de quem está compartilhando. Com upload doméstico típico, de 3 a 5 pessoas em 1080p funciona bem.
- Algumas redes muito restritas (NAT simétrico, redes corporativas) podem bloquear a conexão P2P. Nesse caso seria preciso adicionar um servidor TURN na configuração do `Peer` em `app.js`.
