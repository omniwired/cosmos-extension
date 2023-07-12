/* eslint-disable no-unused-vars */
import { ENCRYPTED_ACTIVE_WALLET, KeyChain } from '@leapwallet/leap-keychain'
import { decrypt } from '@leapwallet/leap-keychain'
import ExtensionPage from 'components/extension-page'
import Loader, { LoaderAnimation } from 'components/loader/Loader'
import { ACTIVE_WALLET } from 'config/storage-keys'
import useQuery from 'hooks/useQuery'
import { Wallet } from 'hooks/wallet/useWallet'
import React, { ReactElement, ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { useRef } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Colors } from 'theme/colors'
import { hasMnemonicWallet } from 'utils/hasMnemonicWallet'
import { isCompassWallet } from 'utils/isCompassWallet'
import browser, { extension } from 'webextension-polyfill'

import { useSetPassword } from '../hooks/settings/usePassword'
import { SeedPhrase } from '../hooks/wallet/seed-phrase/useSeedPhrase'

export type AuthContextType = {
  locked: boolean
  noAccount: boolean
  signin: (password: string, callback?: VoidFunction) => void
  signout: (callback?: VoidFunction) => void
  loading: boolean
}

const AuthContext = React.createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [loading, setLoading] = useState<boolean>(true)
  const [locked, setLocked] = useState<boolean>(true)
  const [noAccount, setNoAccount] = useState<boolean | undefined>(false)
  const setPassword = useSetPassword()
  const testPassword = SeedPhrase.useTestPassword()

  useEffect(() => {
    const el = browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'auto-lock') {
        setLocked(true)
      }
    })

    return () => {
      browser.runtime.onMessage.removeListener((message) => {
        if (message.type === 'auto-lock') {
          setLocked(true)
        }
      })
    }
  }, [])

  const signin = useCallback(
    (password: string, callback?: VoidFunction) => {
      if (!password) {
        setNoAccount(true)
      } else {
        testPassword(password)

        /**
         * when there is an active wallet, we don't need to decrypt the keychain,
         * if we do it will overwrite the active wallet and keychain with the encrypted version
         *
         * on signout, we encrypt the updated keychain and active wallet.
         *
         * for some reason the password authentication failed errors are not propagated to the calling function when using async await
         */
        browser.storage.local.get([ACTIVE_WALLET]).then(async (storage) => {
          browser.runtime.sendMessage({ type: 'unlock', data: { password } })
          const listener = async (message: { type: string }) => {
            if (message.type === 'wallet-unlocked') {
              setLocked(false)
              setNoAccount(false)
              setLoading(false)
              await setPassword(password)
              callback && callback()
              browser.runtime.onMessage.removeListener(listener)
            }
          }

          browser.runtime.onMessage.addListener(listener)
        })
      }
    },
    [setPassword, testPassword],
  )

  const signout = useCallback(
    async (callback?: VoidFunction) => {
      if (locked) return
      await setPassword(null)
      browser.runtime.sendMessage({ type: 'lock' })
      const storage = await browser.storage.local.get([ACTIVE_WALLET, ENCRYPTED_ACTIVE_WALLET])

      if (!storage[ACTIVE_WALLET] && !storage[ENCRYPTED_ACTIVE_WALLET]) {
        setNoAccount(true)
      }
      setLocked(true)
      window.location.reload()

      if (callback) callback()
    },
    [setPassword, locked],
  )

  useEffect(() => {
    const listener = async (message: any) => {
      if (message.type === 'authentication') {
        if (message.data.status === 'success') {
          signin(message.data.password)
        } else {
          setLoading(false)
        }
      }
    }

    const fn = async () => {
      setLoading(true)
      const storage = await browser.storage.local.get([ACTIVE_WALLET, ENCRYPTED_ACTIVE_WALLET])
      if (storage[ACTIVE_WALLET] || storage[ENCRYPTED_ACTIVE_WALLET]) {
        setNoAccount(false)
        browser.runtime.onMessage.addListener(listener)
        browser.runtime.sendMessage({ type: 'popup-open' })
      } else {
        setNoAccount(true)
        setLoading(false)
      }
    }

    fn()

    return () => {
      browser.runtime.onMessage.removeListener(listener)
    }
  }, [signin])

  const value = {
    locked,
    noAccount: noAccount as boolean,
    signin,
    signout,
    loading,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}

export function RequireAuth({
  children,
  hideBorder,
}: {
  children: JSX.Element
  hideBorder?: boolean
}) {
  const auth = useAuth()
  const location = useLocation()

  if (auth?.locked) {
    return <Navigate to='/' state={{ from: location }} replace />
  }

  const views = extension.getViews({ type: 'popup' })

  if (hideBorder) {
    return (
      <div className='relative flex flex-col w-screen h-screen p-[20px] z-0 dark:bg-black-100 overflow-y-scroll pt-0'>
        {children}
      </div>
    )
  }

  return views.length === 0 ? (
    <ExtensionPage>
      <div className='absolute top-0 rounded-2xl flex bottom-0 w-1/2 z-5 justify-center items-center'>
        <div className='dark:shadow-sm shadow-xl dark:shadow-gray-700'>{children}</div>
      </div>
    </ExtensionPage>
  ) : (
    children
  )
}

export function RequireAuthOnboarding({ children }: { children: JSX.Element }) {
  const [redirectTo, setRedirectTo] = useState<'home' | 'onboarding' | undefined>()
  const auth = useAuth()
  const walletName = useQuery().get('walletName') ?? undefined
  const newUser = useRef(false)

  useEffect(() => {
    let mounted = true
    const fn = async () => {
      if (newUser.current) {
        return
      }

      const store = await browser.storage.local.get([ENCRYPTED_ACTIVE_WALLET])
      if (!auth?.loading && auth?.locked && store[ENCRYPTED_ACTIVE_WALLET]) {
        setRedirectTo('home')
        return
      }

      const allWallets = await Wallet.getAllWallets()
      if (!allWallets || Object.keys(allWallets).length === 0) {
        newUser.current = true
      }
      const hasPrimaryWallet = hasMnemonicWallet(allWallets)
      const isLedger = walletName === 'hardwarewallet'

      if (hasPrimaryWallet && !isLedger) {
        setRedirectTo('home')
      } else {
        setRedirectTo('onboarding')
      }
    }
    fn()
    return () => {
      mounted = false
    }
  }, [auth, walletName])

  if (redirectTo === 'onboarding') {
    return children
  }
  if (redirectTo === 'home') {
    return <Navigate to='/' replace />
  }
  return null
}