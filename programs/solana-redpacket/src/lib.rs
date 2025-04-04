pub mod constants;
pub mod transfer;

use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface, close_account, CloseAccount},
};

use solana_program::sysvar::instructions::{load_instruction_at_checked, load_current_index_checked};
use solana_program::hash::hash;


pub use constants::*;
pub use transfer::*;

declare_id!("yoAKw22kCCCStCP5uJ9mkMa8NGjYdtnGgNDxBrv8kfe");


#[program]
pub mod redpacket {
    use super::*;

    pub fn create_red_packet_with_spl_token(ctx: Context<CreateRedPacketWithSPLToken>, total_number: u8, total_amount: u64, create_time: u64, duration: u64, if_spilt_random: bool, pubkey_for_claim_signature: Pubkey, name: String, message: String) -> Result<()> {
        // params check
        require!(total_number > 0 && total_number <= 200, CustomError::InvalidTotalNumber);
        require!(total_amount > 0 , CustomError::InvalidTotalAmount);
        
        // time check
        let _current_time = Clock::get().unwrap().unix_timestamp; 
        require!(_current_time.abs_diff(create_time as i64) < 120, CustomError::InvalidCreateTime);
        require!(create_time + duration > _current_time as u64, CustomError::InvalidExpiryTime);

        // check if the creator has enough tokens
        require!(ctx.accounts.token_account.amount >= total_amount, CustomError::InsufficientTokenBalance);

        transfer::transfer_tokens(
            &ctx.accounts.token_account,
            &ctx.accounts.vault,
            &total_amount,
            &ctx.accounts.token_mint,
            &ctx.accounts.signer.to_account_info(),
            &ctx.accounts.token_program,
            &[]
        )?;       
        initialize_red_packet(&mut ctx.accounts.red_packet, *ctx.accounts.signer.key, total_number, total_amount, create_time, duration, constants::RED_PACKET_USE_CUSTOM_TOKEN, ctx.accounts.token_mint.key(), if_spilt_random, pubkey_for_claim_signature, name, message);

        Ok(())
    }

    pub fn create_red_packet_with_native_token(ctx: Context<CreateRedPacketWithNativeToken>, total_number: u8, total_amount: u64, create_time: u64, duration: u64, if_spilt_random: bool, pubkey_for_claim_signature: Pubkey, name: String, message: String) -> Result<()> {
        // params check
        require!(total_number > 0 && total_number <= 200, CustomError::InvalidTotalNumber);
        require!(total_amount > 0 , CustomError::InvalidTotalAmount);
    
        // time check
        let _current_time = Clock::get().unwrap().unix_timestamp;
        require!(_current_time.abs_diff(create_time as i64) < 120, CustomError::InvalidCreateTime);
        require!(create_time + duration > _current_time as u64, CustomError::InvalidExpiryTime);

        require!(ctx.accounts.signer.lamports() >= total_amount, CustomError::InsufficientTokenBalance);
        // Transfer tokens from initializer to PDA account (red packet account)
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.signer.key(),
            &ctx.accounts.red_packet.key(),
            total_amount
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.signer.to_account_info(),
                ctx.accounts.red_packet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        initialize_red_packet(&mut ctx.accounts.red_packet, *ctx.accounts.signer.key, total_number, total_amount, create_time, duration, constants::RED_PACKET_USE_NATIVE_TOKEN, Pubkey::default(), if_spilt_random, pubkey_for_claim_signature, name, message);
       
        Ok(())
    }
    
    pub fn claim_with_spl_token(ctx: Context<ClaimRedPacketWithSPLToken>) -> Result<()> {
        let red_packet = &mut ctx.accounts.red_packet;
        let _current_time = Clock::get().unwrap().unix_timestamp;
        let expiry = red_packet.create_time + red_packet.duration;
        require!(_current_time < expiry as i64, CustomError::RedPacketExpired);        
        require!(red_packet.claimed_number < red_packet.total_number, CustomError::RedPacketAllClaimed);
        
        // verify signature
        require!(verify_claim_signature(&ctx.accounts.instructions, red_packet.key().as_ref(), ctx.accounts.signer.key.as_ref(), red_packet.pubkey_for_claim_signature.to_bytes().as_ref()).is_ok(), CustomError::InvalidSignature);
        
        let claim_amount = calculate_claim_amount(&red_packet, ctx.accounts.signer.key())?;

        // check if the claim amount is valid
        require!(red_packet.claimed_amount + claim_amount <= red_packet.total_amount, CustomError::InvalidClaimAmount);
        
        // Transfer SPL tokens from vault to claimer's token account
        // Signer seeds for PDA authority
        let binding = red_packet.creator.key();
        let binding_time = red_packet.create_time.to_le_bytes();
        let seeds = &[binding.as_ref(), binding_time.as_ref(), &[ctx.bumps.red_packet]];
        let signer_seeds = &[&seeds[..]];
        transfer::transfer_tokens(
            &ctx.accounts.vault,
            &ctx.accounts.token_account,
            &claim_amount,
            &ctx.accounts.token_mint,
            &red_packet.to_account_info(),
            &ctx.accounts.token_program,
            signer_seeds
        )?;
        
        red_packet.claimed_number += 1;
        red_packet.claimed_amount += claim_amount;

        ctx.accounts.claim_record.set_inner(ClaimRecord {
            red_packet_key: red_packet.key(),
            claimer: *ctx.accounts.signer.key,
            amount: claim_amount,
        }); 

        msg!("claim_red_packet: {}", red_packet.key());
        msg!("claimer: {}", *ctx.accounts.signer.key);
        msg!("claim_token_address: {}", ctx.accounts.token_mint.key());
        msg!("claim_amount: {}", claim_amount);
        
        Ok(())
    }

    pub fn claim_with_native_token(ctx: Context<ClaimRedPacketWithNativeToken>) -> Result<()> {
        let red_packet = &mut ctx.accounts.red_packet;

        let current_time: u64 = Clock::get()?.unix_timestamp.try_into().unwrap();
        let expiry = red_packet.create_time + red_packet.duration;
        require!(current_time < expiry, CustomError::RedPacketExpired);
        require!(red_packet.claimed_number < red_packet.total_number, CustomError::RedPacketAllClaimed);

        // verify signature
        require!(verify_claim_signature(&ctx.accounts.instructions, red_packet.key().as_ref(), ctx.accounts.signer.key.as_ref(), red_packet.pubkey_for_claim_signature.to_bytes().as_ref()).is_ok(), CustomError::InvalidSignature);
        let claim_amount = calculate_claim_amount(&red_packet, ctx.accounts.signer.key())?;
        
        // check if the claim amount is valid
        require!(red_packet.claimed_amount + claim_amount <= red_packet.total_amount, CustomError::InvalidClaimAmount);
       
        // Transfer SOL using native transfer
        **red_packet.to_account_info().try_borrow_mut_lamports()? -= claim_amount;
        **ctx.accounts.signer.to_account_info().try_borrow_mut_lamports()? += claim_amount;
        red_packet.claimed_number += 1;
        red_packet.claimed_amount += claim_amount;

        ctx.accounts.claim_record.set_inner(ClaimRecord {
            red_packet_key: red_packet.key(),
            claimer: *ctx.accounts.signer.key,
            amount: claim_amount,
        }); 

        msg!("claim_red_packet: {}", red_packet.key());
        msg!("claimer: {}", *ctx.accounts.signer.key);
        msg!("claim_token_address: {}", red_packet.token_address.to_string());
        msg!("claim_amount: {}", claim_amount);
        Ok(())
    }

    pub fn withdraw_with_spl_token(ctx: Context<WithdrawRedPacketWithSPLToken>) -> Result<()> {
        let red_packet = &mut ctx.accounts.red_packet;
        let _current_time: u64 = Clock::get()?.unix_timestamp.try_into().unwrap();
        let expiry = red_packet.create_time + red_packet.duration;
        require!(_current_time >= expiry, CustomError::RedPacketNotExpired);
        require!(red_packet.creator == *ctx.accounts.signer.key, CustomError::Unauthorized);

        let remaining_amount = red_packet.total_amount - red_packet.claimed_amount;
       
        // Transfer SPL tokens from vault to creator's token account
        // Signer seeds for PDA authority
        let binding = red_packet.creator.key();
        let binding_time = red_packet.create_time.to_le_bytes();
        let seeds = &[binding.as_ref(), binding_time.as_ref(), &[ctx.bumps.red_packet]];
        let signer_seeds = &[&seeds[..]];
        transfer::transfer_tokens(
            &ctx.accounts.vault,
            &ctx.accounts.token_account,
            &remaining_amount,
            &ctx.accounts.token_mint,
            &red_packet.to_account_info(),
            &ctx.accounts.token_program,
            signer_seeds
        )?;

        let accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.signer.to_account_info(),
            authority: ctx.accounts.red_packet.to_account_info(),
        };
        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            accounts,
            signer_seeds,
        );
        close_account(cpi_context)?;

        // Transfer all redpacket lamports (remaining balance + rent) to signer
        let dest_starting_lamports = ctx.accounts.signer.lamports();
        let red_packet_lamports = ctx.accounts.red_packet.to_account_info().lamports();
        **ctx.accounts.red_packet.to_account_info().try_borrow_mut_lamports()? = 0;
        **ctx.accounts.signer.to_account_info().try_borrow_mut_lamports()? = dest_starting_lamports
            .checked_add(red_packet_lamports)
            .unwrap();

        msg!("withdraw_red_packet: {}", ctx.accounts.red_packet.key());
        msg!("withdraw_signer: {}", *ctx.accounts.signer.key);
        msg!("withdraw_token_address: {}", ctx.accounts.token_mint.key());
        msg!("withdraw_red_packet_remaining_lamports: {}", red_packet_lamports);
        msg!("withdraw_amount: {}", remaining_amount);

        Ok(())
    }

    pub fn withdraw_with_native_token(ctx: Context<WithdrawRedPacketWithNativeToken>) -> Result<()> {
        let red_packet = &mut ctx.accounts.red_packet;
        let current_time: u64 = Clock::get()?.unix_timestamp.try_into().unwrap();
        let expiry = red_packet.create_time + red_packet.duration;
        require!(current_time >= expiry, CustomError::RedPacketNotExpired);
        require!(red_packet.creator == *ctx.accounts.signer.key, CustomError::Unauthorized);
      
        // Transfer all lamports (remaining balance + rent) to signer
        let dest_starting_lamports = ctx.accounts.signer.lamports();
        let red_packet_lamports = ctx.accounts.red_packet.to_account_info().lamports();
        let remaining_amount = ctx.accounts.red_packet.total_amount - ctx.accounts.red_packet.claimed_amount;

        **ctx.accounts.red_packet.to_account_info().try_borrow_mut_lamports()? = 0;
        **ctx.accounts.signer.to_account_info().try_borrow_mut_lamports()? = dest_starting_lamports
            .checked_add(red_packet_lamports)
            .unwrap();
        
        msg!("withdraw_red_packet: {}", ctx.accounts.red_packet.key());
        msg!("withdraw_signer: {}", *ctx.accounts.signer.key);
        msg!("withdraw_token_address: {}", ctx.accounts.red_packet.token_address);
        msg!("withdraw_red_packet_remaining_lamports: {}", remaining_amount);
        msg!("withdraw_amount: {}", red_packet_lamports);
        
        Ok(())
    }

}

#[derive(Accounts)]
#[instruction(total_number: u8, total_amount: u64, create_time: u64)] 
pub struct CreateRedPacketWithSPLToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    
    #[account(
        init, 
        payer = signer, 
        space = 8 + RedPacket::INIT_SPACE, 
        seeds = [signer.key().as_ref(), create_time.to_le_bytes().as_ref()], 
        bump
    )]
    pub red_packet: Account<'info, RedPacket>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        init,
        payer = signer,
        associated_token::mint = token_mint,
        associated_token::authority = red_packet,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct ClaimRedPacketWithSPLToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [red_packet.creator.key().as_ref(), red_packet.create_time.to_le_bytes().as_ref()], bump)]
    pub red_packet: Account<'info, RedPacket>,
    
    #[account(init, payer = signer, space = 8 + ClaimRecord::INIT_SPACE, seeds = [ b"claim_record", red_packet.key().as_ref(), signer.key().as_ref()], bump)]
    pub claim_record: Account<'info, ClaimRecord>,
  
    #[account(address = red_packet.token_address)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed, 
        payer = signer,
        associated_token::mint = token_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = red_packet,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: follow the code 
    /// https://github.com/GuidoDipietro/solana-ed25519-secp256k1-sig-verification/blob/master/programs/solana-ed25519-sig-verification/src/lib.rs
    /// https://solana.stackexchange.com/questions/16487/about-verify-signature-with-ed25519-issue?rq=1
    #[account(address = solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
    /// CHECK: Ed25519Program ID is checked in constraint
    #[account(address = anchor_lang::solana_program::ed25519_program::ID)]
    pub ed25519_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawRedPacketWithSPLToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [red_packet.creator.key().as_ref(), red_packet.create_time.to_le_bytes().as_ref()], bump)]
    pub red_packet: Account<'info, RedPacket>,

    #[account(address = red_packet.token_address)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed, 
        payer = signer,
        associated_token::mint = token_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = red_packet,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(total_number: u8, total_amount: u64, create_time: u64)] 
pub struct CreateRedPacketWithNativeToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(init, payer = signer, space = 8 + RedPacket::INIT_SPACE, seeds = [signer.key().as_ref(), create_time.to_le_bytes().as_ref()], bump)]
    pub red_packet: Account<'info, RedPacket>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRedPacketWithNativeToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [red_packet.creator.key().as_ref(), red_packet.create_time.to_le_bytes().as_ref()], bump)]
    pub red_packet: Account<'info, RedPacket>,

    #[account(init, payer = signer, space = 8 + ClaimRecord::INIT_SPACE, seeds = [ b"claim_record", red_packet.key().as_ref(), signer.key().as_ref()], bump)]
    pub claim_record: Account<'info, ClaimRecord>,

    pub system_program: Program<'info, System>,
    /// CHECK: follow the code 
    /// https://github.com/GuidoDipietro/solana-ed25519-secp256k1-sig-verification/blob/master/programs/solana-ed25519-sig-verification/src/lib.rs
    /// https://solana.stackexchange.com/questions/16487/about-verify-signature-with-ed25519-issue?rq=1
    #[account(address = solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
    /// CHECK: Ed25519Program ID is checked in constraint
    #[account(address = anchor_lang::solana_program::ed25519_program::ID)]
    pub ed25519_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawRedPacketWithNativeToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [red_packet.creator.key().as_ref(), red_packet.create_time.to_le_bytes().as_ref()], bump)]
    pub red_packet: Account<'info, RedPacket>,

    pub system_program: Program<'info, System>,
}


#[derive(AnchorSerialize, AnchorDeserialize)]
struct Ed25519SignatureOffsets {
    signature_offset: u16,             // offset to ed25519 signature of 64 bytes
    signature_instruction_index: u16,  // instruction index to find signature
    public_key_offset: u16,            // offset to public key of 32 bytes
    public_key_instruction_index: u16, // instruction index to find public key
    message_data_offset: u16,          // offset to start of message data
    message_data_size: u16,            // size of message data
    message_instruction_index: u16,    // index of instruction data to get message data
}

#[account]
#[derive(InitSpace)]
pub struct RedPacket {
    pub creator: Pubkey,
    pub total_number: u8,
    pub claimed_number: u8,
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub create_time: u64,
    pub duration: u64,
    pub token_type: u8, // 0: SOL, 1: SPL Token
    pub token_address: Pubkey,
    pub if_spilt_random: bool,
    pub pubkey_for_claim_signature: Pubkey, // Record of claimers' pubkey and claim amount
    #[max_len(100)]
    pub name: String,
    #[max_len(200)]
    pub message: String,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub red_packet_key: Pubkey,
    pub claimer: Pubkey,
    pub amount: u64,
}

pub fn initialize_red_packet(
    red_packet: &mut Account<RedPacket>,
    creator: Pubkey,
    total_number: u8,
    total_amount: u64,
    create_time: u64,
    duration: u64,
    token_type: u8,
    token_address: Pubkey,
    if_spilt_random: bool,
    pubkey_for_claim_signature: Pubkey,
    name: String,
    message: String,
) {
    msg!("create_red_packet: {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}", red_packet.key(), creator.key(), total_number, total_amount, create_time, duration, constants::RED_PACKET_USE_CUSTOM_TOKEN, token_address.to_string(), if_spilt_random, pubkey_for_claim_signature, name, message);
    red_packet.set_inner(RedPacket {
        creator,
        total_number,
        claimed_number: 0,
        total_amount,
        claimed_amount: 0,
        create_time,
        duration,
        token_type,
        token_address,
        if_spilt_random,
        pubkey_for_claim_signature,
        name,
        message,
    });
}

fn calculate_claim_amount(red_packet: &Account<RedPacket>, signer_key: Pubkey) -> Result<u64> {

    let remaining_amount = red_packet.total_amount - red_packet.claimed_amount;
    if red_packet.total_number - red_packet.claimed_number == 1 {
        return Ok(remaining_amount);
    }

    if red_packet.if_spilt_random == constants::RED_PACKET_SPILT_EQUAL {
        return Ok(red_packet.total_amount / red_packet.total_number as u64);   
    } 
    
    let random_value = generate_random_number(red_packet.key(), signer_key, red_packet.claimed_amount);
    let remaining_users = (red_packet.total_number - red_packet.claimed_number) as u64;

    let doubled_amount = remaining_amount.checked_mul(2)
        .ok_or(error!(CustomError::ArithmeticOverflow))?;

        let max_per_user = doubled_amount.checked_div(remaining_users)
        .ok_or(error!(CustomError::ArithmeticOverflow))?;

    let claim_value = random_value % max_per_user;
    let claim_amount = if claim_value == 0 { 1 } else { claim_value };

    Ok(claim_amount)
}

fn generate_random_number(redpacket_key: Pubkey, signer_key: Pubkey, claimed_amount: u64) -> u64 {
    let clock = Clock::get().unwrap();
    let current_timestamp = clock.unix_timestamp;
    let current_slot = clock.slot;

    let seed = format!("{}{}{}{}{}", redpacket_key, signer_key, current_timestamp, claimed_amount, current_slot);
    let hash_value = hash(seed.as_bytes()); 
    u64::from_le_bytes(hash_value.to_bytes()[0..8].try_into().unwrap())
}

pub fn verify_claim_signature(
    instruction_sysvar: &AccountInfo,
    red_packet_key: &[u8],
    claimer_key: &[u8],
    expected_public_key_arr: &[u8]
) -> Result<()> {
    let current_index = load_current_index_checked(instruction_sysvar)?;
    if current_index == 0 {
        msg!("fail to get instruction from current_index: {}", current_index);
        return Err(error!(CustomError::InvalidSignature));
    }

    let ed25519_instruction = load_instruction_at_checked((current_index - 1) as usize, instruction_sysvar)?;
    
    // Verify the content of the Ed25519 instruction
    let instruction_data = ed25519_instruction.data;
    if instruction_data.len() < 2 {
        msg!("fail to get instruction_data from instruction: {}", instruction_data.len());
        return Err(error!(CustomError::InvalidSignature));
    }

    let num_signatures = instruction_data[0];
    if num_signatures != 1 {
        msg!("fail to get num_signatures from instruction: {}", num_signatures);
        return Err(error!(CustomError::InvalidSignature));
    }

    // Parse Ed25519SignatureOffsets
    let offsets: Ed25519SignatureOffsets = Ed25519SignatureOffsets::try_from_slice(&instruction_data[2..16])?;

    // Verify public key
    let pubkey_start = offsets.public_key_offset as usize;
    let pubkey_end = pubkey_start + 32;
    let pubkey_arr = &instruction_data[pubkey_start..pubkey_end];
    if pubkey_arr != expected_public_key_arr {
        msg!("fail to verify pubkey_arr: {:?}", pubkey_arr);
        msg!("fail to verify expected_public_key: {:?}", expected_public_key_arr);
        return Err(error!(CustomError::InvalidSignature));
    }

    // Verify message
    let expected_message = [red_packet_key, claimer_key].concat();
    let msg_start = offsets.message_data_offset as usize;
    let msg_end = msg_start + offsets.message_data_size as usize;
    if &instruction_data[msg_start..msg_end] != expected_message {
        return Err(error!(CustomError::InvalidSignature));
    }

    Ok(())
}

#[error_code]
pub enum CustomError {
    #[msg("Invalid red packet id.")]
    InvalidRedPacketId,
    #[msg("Invalid create time.")]
    InvalidCreateTime,
    #[msg("Invalid expiry time.")]
    InvalidExpiryTime,
    #[msg("Invalid total number.")]
    InvalidTotalNumber,
    #[msg("Invalid total amount.")]
    InvalidTotalAmount,
    #[msg("Insufficient token balance.")]
    InsufficientTokenBalance,
    #[msg("Invalid token type.")]
    InvalidTokenType,
    #[msg("Invalid account for native token.")]
    InvalidAccountForNativeToken,
    #[msg("Invalid initial params for token account.")]
    InvalidInitialParamsForTokenAccount,
    #[msg("The red packet has expired.")]
    RedPacketExpired,
    #[msg("Invalid signature.")]
    InvalidSignature,
    #[msg("The claim amount is invalid.")]
    InvalidClaimAmount,
    #[msg("The red packet has not yet expired.")]
    RedPacketNotExpired,
    #[msg("The red packet has been claimed.")]
    RedPacketClaimed,
    #[msg("All the red packet has been claimed.")]
    RedPacketAllClaimed,
    #[msg("You are not authorized to perform this action.")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}