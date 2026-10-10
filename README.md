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

## Observações

- O link funciona enquanto a sua aba estiver aberta. Se você fechar e abrir de novo, um novo link é gerado.
- **Áudio**: no Chrome/Edge, marque "Compartilhar áudio" na janela de seleção da tela.
- Cada amigo recebe uma cópia do stream enviada pelo seu upload. Com upload doméstico típico, de 3 a 5 pessoas em 1080p funciona bem.
- Algumas redes muito restritas (NAT simétrico, redes corporativas) podem bloquear a conexão P2P. Nesse caso seria preciso adicionar um servidor TURN na configuração do `Peer` em `app.js`.
